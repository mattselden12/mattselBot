// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// bot.js is your main bot dialog entry point for handling activity types

// Import required Bot Builder
const { ActivityTypes, CardFactory } = require('botbuilder');
const { LuisRecognizer } = require('botbuilder-ai');
const { DialogSet, DialogTurnStatus } = require('botbuilder-dialogs');

const { UserProfile } = require('./dialogs/greeting/userProfile');
const { WelcomeCard } = require('./dialogs/welcome');
const { GreetingDialog } = require('./dialogs/greeting');

// My Variables
const axios = require('axios');
const { creator, resolver } = require('@microsoft/recognizers-text-data-types-timex-expression');
var weather;
var forecast;

//extend Date prototype
Date.prototype.getDayName = function () {
    var weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return weekday[this.getDay()];
}

// Greeting Dialog ID
const GREETING_DIALOG = 'greetingDialog';

// State Accessor Properties
const DIALOG_STATE_PROPERTY = 'dialogState';
const USER_PROFILE_PROPERTY = 'userProfileProperty';

// LUIS service type entry as defined in the .bot file.
const LUIS_CONFIGURATION = 'BasicBotLuisApplication';

// Supported LUIS Intents.
const GREETING_INTENT = 'Greeting';
const CANCEL_INTENT = 'Cancel';
const HELP_INTENT = 'Help';
const NONE_INTENT = 'None';
const TODAY_INTENT = 'WeatherToday';
const FORECAST_INTENT = 'WeatherLater';

// Supported LUIS Entities, defined in ./dialogs/greeting/resources/greeting.lu
const USER_NAME_ENTITIES = ['userName', 'userName_patternAny'];
const USER_LOCATION_ENTITIES = ['userLocation', 'userLocation_patternAny'];

/**
 * Demonstrates the following concepts:
 *  Displaying a Welcome Card, using Adaptive Card technology
 *  Use LUIS to model Greetings, Help, and Cancel interactions
 *  Use a Waterfall dialog to model multi-turn conversation flow
 *  Use custom prompts to validate user input
 *  Store conversation and user state
 *  Handle conversation interruptions
 */
class BasicBot {
    /**
     * Constructs the three pieces necessary for this bot to operate:
     * 1. StatePropertyAccessor for conversation state
     * 2. StatePropertyAccess for user state
     * 3. LUIS client
     * 4. DialogSet to handle our GreetingDialog
     *
     * @param {ConversationState} conversationState property accessor
     * @param {UserState} userState property accessor
     * @param {BotConfiguration} botConfig contents of the .bot file
     */
    constructor(conversationState, userState, botConfig) {
        if (!conversationState) throw new Error('Missing parameter.  conversationState is required');
        if (!userState) throw new Error('Missing parameter.  userState is required');
        if (!botConfig) throw new Error('Missing parameter.  botConfig is required');

        // Add the LUIS recognizer.
        const luisConfig = botConfig.findServiceByNameOrId(LUIS_CONFIGURATION);
        if (!luisConfig || !luisConfig.appId) throw new Error('Missing LUIS configuration. Please follow README.MD to create required LUIS applications.\n\n');
        const luisEndpoint = luisConfig.region && luisConfig.region.indexOf('https://') === 0 ? luisConfig.region : luisConfig.getEndpoint();
        this.luisRecognizer = new LuisRecognizer({
            applicationId: luisConfig.appId,
            endpoint: luisEndpoint,
            // CAUTION: Its better to assign and use a subscription key instead of authoring key here.
            endpointKey: luisConfig.authoringKey
        });

        // Create the property accessors for user and conversation state
        this.userProfileAccessor = userState.createProperty(USER_PROFILE_PROPERTY);
        this.dialogState = conversationState.createProperty(DIALOG_STATE_PROPERTY);

        // Create top-level dialog(s)
        this.dialogs = new DialogSet(this.dialogState);
        // Add the Greeting dialog to the set
        this.dialogs.add(new GreetingDialog(GREETING_DIALOG, this.userProfileAccessor));

        this.conversationState = conversationState;
        this.userState = userState;
    }

    /**
     * Driver code that does one of the following:
     * 1. Display a welcome card upon receiving ConversationUpdate activity
     * 2. Use LUIS to recognize intents for incoming user message
     * 3. Start a greeting dialog
     * 4. Optionally handle Cancel or Help interruptions
     *
     * @param {Context} context turn context from the adapter
     */
    async onTurn(context) {
        // Handle Message activity type, which is the main activity type for shown within a conversational interface
        // Message activities may contain text, speech, interactive cards, and binary or unknown attachments.
        // see https://aka.ms/about-bot-activity-message to learn more about the message and other activity types
        if (context.activity.type === ActivityTypes.Message) {
            let dialogResult;
            // Create a dialog context
            const dc = await this.dialogs.createContext(context);

            // Perform a call to LUIS to retrieve results for the current activity message.
            const results = await this.luisRecognizer.recognize(context);
            const topIntent = LuisRecognizer.topIntent(results);

            // update user profile property with any entities captured by LUIS
            // This could be user responding with their name or city while we are in the middle of greeting dialog,
            // or user saying something like 'i'm {userName}' while we have no active multi-turn dialog.
            await this.updateUserProfile(results, context);

            // Based on LUIS topIntent, evaluate if we have an interruption.
            // Interruption here refers to user looking for help/ cancel existing dialog
            const interrupted = await this.isTurnInterrupted(dc, results);
            if (interrupted) {
                if (dc.activeDialog !== undefined) {
                    // issue a re-prompt on the active dialog
                    dialogResult = await dc.repromptDialog();
                } // Else: We dont have an active dialog so nothing to continue here.
            } else {
                // No interruption. Continue any active dialogs.
                dialogResult = await dc.continueDialog();
            }

            // If no active dialog or no active dialog has responded,
            if (!dc.context.responded) {
                // Switch on return results from any active dialog.
                switch (dialogResult.status) {
                    // dc.continueDialog() returns DialogTurnStatus.empty if there are no active dialogs
                    case DialogTurnStatus.empty:
                        // Determine what we should do based on the top intent from LUIS.
                        switch (topIntent) {
                            // case FLIGHT_INTENT:
                                // await dc.context.sendActivity('I will try to book your flight.')
                                // break;
                            case GREETING_INTENT:
                                await dc.beginDialog(GREETING_DIALOG);
                                break;
                            case NONE_INTENT:
                            default:
                                // None or no intent identified, either way, let's provide some help
                                // to the user
                                await dc.context.sendActivity(`I didn't understand what you just said to me.`);
                                break;
                            }
                        break;
                    case DialogTurnStatus.waiting:
                        // The active dialog is waiting for a response from the user, so do nothing.
                        break;
                    case DialogTurnStatus.complete:
                        // All child dialogs have ended. so do nothing.
                        break;
                    default:
                        // Unrecognized status from child dialog. Cancel all dialogs.
                        await dc.cancelAllDialogs();
                        break;
                }
            }
        } else if (context.activity.type === ActivityTypes.ConversationUpdate) {
            // Handle ConversationUpdate activity type, which is used to indicates new members add to
            // the conversation.
            // see https://aka.ms/about-bot-activity-message to learn more about the message and other activity types

            // Do we have any new members added to the conversation?
            if (context.activity.membersAdded.length !== 0) {
                // Iterate over all new members added to the conversation
                for (var idx in context.activity.membersAdded) {
                    // Greet anyone that was not the target (recipient) of this message
                    // the 'bot' is the recipient for events from the channel,
                    // context.activity.membersAdded == context.activity.recipient.Id indicates the
                    // bot was added to the conversation.
                    if (context.activity.membersAdded[idx].id !== context.activity.recipient.id) {
                        // Welcome user.
                        // When activity type is "conversationUpdate" and the member joining the conversation is the bot
                        // we will send our Welcome Adaptive Card.  This will only be sent once, when the Bot joins conversation
                        // To learn more about Adaptive Cards, see https://aka.ms/msbot-adaptivecards for more details.
                        // const welcomeCard = CardFactory.adaptiveCard(WelcomeCard);
                        // await context.sendActivity({ attachments: [welcomeCard] });
                        let returnval = await axios.get('https://api.openweathermap.org/data/2.5/weather?id=5809844&APPID=fe714b780e2777640d3e88a5e606ced4&q=');
                        weather = returnval['data'];
                        returnval = await axios.get('https://api.openweathermap.org/data/2.5/forecast?id=5809844&APPID=fe714b780e2777640d3e88a5e606ced4&q=');
                        forecast = returnval['data']['list'];
                        await context.sendActivity('Welcome to the Seattle Weather Bot!  Ask me about the weather over the next 5 days.');
                    }
                }
            }
        }

        // make sure to persist state at the end of a turn.
        await this.conversationState.saveChanges(context);
        await this.userState.saveChanges(context);
    }

    /**
     * Look at the LUIS results and determine if we need to handle
     * an interruptions due to a Help or Cancel intent
     *
     * @param {DialogContext} dc - dialog context
     * @param {LuisResults} luisResults - LUIS recognizer results
     */
    async isTurnInterrupted(dc, luisResults) {
        const topIntent = LuisRecognizer.topIntent(luisResults);

        if (topIntent === TODAY_INTENT) {
            let temp = Math.round((9/5)*(weather["main"]["temp"] - 273) + 32)
            await dc.context.sendActivity('The weather for today is showing that there should be ' + weather["weather"][0]["description"] + '.');
            await dc.context.sendActivity('The temperature should be around ' + temp + ' degrees fahrenheit.');
            const reply = { type: ActivityTypes.Message };
            if (weather["weather"][0]["main"] == "Clouds") {
                reply.attachments = [{
                    name: 'clouds',
                    contentType: 'image/png',
                    contentUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/40/Draw_cloudy.png'
                }];
            } else if (weather["weather"][0]["main"] == "Rain") {
                reply.attachments = [{
                    name: 'rain',
                    contentType: 'image/png',
                    contentUrl: 'https://www.seekpng.com/png/detail/181-1815963_rain-emoji-png-png-stock-cloud-rain-clipart.png'
                }];
            } else if (weather["weather"][0]["main"] == "Clear") {
                reply.attachments = [{
                    name: 'clear',
                    contentType: 'image/png',
                    contentUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/92/Draw_sunny.png'
                }];
            }
            await dc.context.sendActivity(reply);
            return true;
        }

        else if (topIntent === FORECAST_INTENT) {
            let entityData = String(luisResults.entities["datetime"][0]["timex"][0]);
            const resolutions = resolver.evaluate(
                [entityData], [creator.weekFromToday()]
            );
            resolutions.forEach(resolution => {
                entityData = new Date(resolution.year, resolution.month - 1, resolution.dayOfMonth, 12, 0, 0, 0);
            });
            let holder;
            if(entityData instanceof Date){
                for(let i = 0; i < forecast.length; i++){
                    var tempdate = new Date(forecast[i]["dt_txt"])
                    if(tempdate.getTime() === entityData.getTime()){
                        holder = forecast[i];
                    }
                }
            }
            else{
                await dc.context.sendActivity('Sorry, I can only give you the weather for the next 5 days.');
                return true;
            }
            if(holder){
                let temp = Math.round((9 / 5) * (holder["main"]["temp"] - 273) + 32);
                await dc.context.sendActivity('The weather for ' + entityData.getDayName() + ' is showing that there should be ' + holder["weather"][0]["description"] + '.');
                await dc.context.sendActivity('The temperature should be around ' + temp + ' degrees fahrenheit.');
                let reply = { type: ActivityTypes.Message };
                if (holder["weather"][0]["main"]=="Clouds"){
                    reply.attachments = [{
                        name: 'clouds',
                        contentType: 'image/png',
                        contentUrl: 'https://upload.wikimedia.org/wikipedia/commons/4/40/Draw_cloudy.png'
                    }];
                } else if (holder["weather"][0]["main"] == "Rain"){
                    reply.attachments = [{
                        name: 'rain',
                        contentType: 'image/png',
                        contentUrl: 'https://www.seekpng.com/png/detail/181-1815963_rain-emoji-png-png-stock-cloud-rain-clipart.png'
                    }];
                } else if (holder["weather"][0]["main"] == "Clear"){
                    reply.attachments = [{
                        name: 'clear',
                        contentType: 'image/png',
                        contentUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/92/Draw_sunny.png'
                    }];
                }
                await dc.context.sendActivity(reply);
            }
            else{
                await dc.context.sendActivity('Sorry, I can only give you the weather for the next 5 days.');
            }
            return true;
        }

        // see if there are anh conversation interrupts we need to handle
        else if (topIntent === CANCEL_INTENT) {
            if (dc.activeDialog) {
                // cancel all active dialog (clean the stack)
                await dc.cancelAllDialogs();
                await dc.context.sendActivity(`Ok.  I've cancelled our last activity.`);
            } else {
                await dc.context.sendActivity(`I don't have anything to cancel.`);
            }
            return true; // this is an interruption
        }

        if (topIntent === HELP_INTENT) {
            await dc.context.sendActivity(`Let me try to provide some help.`);
            await dc.context.sendActivity(`I can give you weather predictions for the next 5 days, just ask me the name of the day!`);
            await dc.context.sendActivity(`I also understand greetings, being asked for help, or being asked to cancel what I am doing.`);
            return true; // this is an interruption
        }

        return false; // this is not an interruption
    }

    /**
     * Helper function to update user profile with entities returned by LUIS.
     *
     * @param {LuisResults} luisResults - LUIS recognizer results
     * @param {DialogContext} dc - dialog context
     */
    async updateUserProfile(luisResult, context) {
        // Do we have any entities?
        if (Object.keys(luisResult.entities).length !== 1) {
            // get userProfile object using the accessor
            let userProfile = await this.userProfileAccessor.get(context);
            if (userProfile === undefined) {
                userProfile = new UserProfile();
            }
            // see if we have any user name entities
            USER_NAME_ENTITIES.forEach(name => {
                if (luisResult.entities[name] !== undefined) {
                    let lowerCaseName = luisResult.entities[name][0];
                    // capitalize and set user name
                    userProfile.name = lowerCaseName.charAt(0).toUpperCase() + lowerCaseName.substr(1);
                }
            });
            USER_LOCATION_ENTITIES.forEach(city => {
                if (luisResult.entities[city] !== undefined) {
                    let lowerCaseCity = luisResult.entities[city][0];
                    // capitalize and set user name
                    userProfile.city = lowerCaseCity.charAt(0).toUpperCase() + lowerCaseCity.substr(1);
                }
            });
            // set the new values
            await this.userProfileAccessor.set(context, userProfile);
        }
    }
}

module.exports.BasicBot = BasicBot;
