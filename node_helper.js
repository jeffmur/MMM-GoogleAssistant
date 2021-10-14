/** Porcupine module **/
"use strict"
const path = require("path")
var NodeHelper = require("node_helper")
var savedState = undefined
// Google Assistant + Wake Word
const Speaker = require('speaker');
const speakerHelper = require('./src/speaker-helper');
const record = require('node-record-lpcm16');
const Porcupine = require("@picovoice/porcupine-node");
const PvRecorder = require("@picovoice/pvrecorder-node");
const GoogleAssistant = require('./index') // using custom sdk
var WakeWords = require("@picovoice/porcupine-node/builtin_keywords")

// Logging function to log MMM-Porcupine output, in this case it is binding the
// output of the current script to the console with the [PORCUPINE] context
var _log = function() {
    var context = "[PORCUPINE]"
    return Function.prototype.bind.call(console.log, console, context)
}()

// Logging
var log = function() {
  //do nothing
}

const config = {
  debug : false,
  auth: {
    keyFilePath: path.resolve(__dirname, 'src/client_secret.json'),
    savedTokensPath: path.resolve(__dirname, 'src/tokens.json'), // where you want the tokens to be saved
  },
  user : {
    hotwords: ["HOTWORD"], // see node_modules/@picovoice/porcupine-node/builtin_keywords.js
    hotkeys: [0],
    sensitivity: [0.5],
    handle: null,    // do not edit
    assistant: null, // do not edit   
    conversation: null,
  },
  conv: {
    audio: {
      sampleRateOut: 24000, // defaults to 24000
    },
    lang: 'en-US', // defaults to en-US, but try other ones, it's fun!
  },
};

// export functions for use elsewhere
module.exports = NodeHelper.create({
  // Start function
  start: function () {
    this.running = false
  },

  socketNotificationReceived: function(notification, payload) {
    switch(notification) {
      case "INIT":
        console.log("[PORCUPINE] Initializing...")
        // set the internal config to the payload received in socket notification
        config.user = payload
        let tmp = []
        config.user.hotwords.forEach(word => {
          tmp.push(WakeWords.BUILTIN_KEYWORDS_STRING_TO_ENUM.get(word))
        })
        
        config.user.hotkeys = tmp
        this.initialize()
        break
      case "START":
        // if we get a START socket notification, tell Porcupine to start listening
        log("Recieved START")
        if (!this.running) this.activate()
        break
      case "STOP":
        // If we get a STOP socket notification, tell Porcupine to stop listening
        if (this.running) this.deactivate()
        break
    }
  },

  initialize: function() {
    // if config has debug=true then start in debug mode, else dont
    var debug = (config.debug) ? config.debug : false
    if (debug == true) log = _log

    savedState = this

    log('USING HOTWORDS:', config.user.hotwords)
    log('SENSITIVITY:', config.user.sensitivity)
  },

  // Tell Porcupine to start listening
  activate: function() {
    this.listenForWakeWord();
  },

  // Tell Porcupine to stop listening
  deactivate: function() {
    // this.porcupine.stop()
    // this.running = false
  },

 /* Porcupine + Google Assistant
  * listenForWakeWord()
  * Details:
  * 
  */
 listenForWakeWord: function() {
  let handle = new Porcupine(config.user.hotkeys, config.user.sensitivity)
  config.user.handle = handle
  // Default Audio Device
  // @param (default mic, 512 buffer, 1000 ms save array, )
  const recorder = new PvRecorder(-1, 512, 1000, false);
  recorder.start(); 
  console.log("Listening for '"+config.user.hotwords+"'...")   

  let isInterrupted = false
  let index = -1

  // Interrupt called when wake word is called
  while (!isInterrupted) {
    const pcm = recorder.readSync();
    index = handle.process(pcm);

    if(index !== -1)
    {    
      this.sendSocketNotification("WAKEWORD_DETECTED", undefined)
      isInterrupted = true
    }
  }
  recorder.release()
  // Google Assistant
  const assistant = new GoogleAssistant(config.auth);
  config.user.assistant = assistant
    assistant
    .on('ready', () => {
        // start a conversation!
        assistant.start(config.conv);
    })
    .on('started', this.startConversation)
    .on('error', (error) => {
        console.log('Assistant Error:', error);
        record.stop()
        speaker.end()
    });
  },

  startConversation: function (conversation) {
    console.log('Say something!');
    let openMicAgain = false; // continue 'conversation'
    let speakerPass = false; // event gets called twice
    // setup the conversation
    conversation
      // send the audio buffer to the speaker
      .on('audio-data', (data) => {
        speakerHelper.update(data);
      })
      // done speaking, close the mic
      .on('end-of-utterance', () => record.stop())
      // just to spit out to the console what was said (as we say it)
      .on('transcription', data => { 
        console.log('Transcription:', data.transcription, ' --- Done:', data.done)
        savedState.sendSocketNotification("ON_CONVERSATION_UPDATE", data.transcription)
      }) //data.done
      // what the assistant said back
      .on('response', text => console.log('Assistant Text Response:', text))
      // if we've requested a volume level change, get the percentage of the new level
      .on('volume-percent', percent => console.log('New Volume Percent:', percent))
      // the device needs to complete an action
      .on('device-action', action => console.log('Device Action:', action))
      // once the conversation is ended, see if we need to follow up
      .on('ended', (error, continueConversation) => {
        if (error) console.log("End Conversation Error: ", error)
        else if (continueConversation == true) openMicAgain = true;
        else savedState.sendSocketNotification("ON_CONVERSATION_FINISH", undefined)

      })
      // catch any errors
      .on('error', (error) => {
        console.log('Steaming Conversation Error:', error);
      });

    // pass the mic audio to the assistant
    const mic = record.start({ threshold: 0, recordProgram: 'arecord'});
    mic.on('data', data => {
      conversation.write(data)
    });

    // setup the speaker
    const speaker = new Speaker({
      channels: 1,
      sampleRate: config.conv.audio.sampleRateOut,
    });
    speakerHelper.init(speaker);
    speaker
      .on('open', () => {
        record.stop()
        console.log('Assistant Speaking');
        speakerHelper.open();
      })
      .on('close', () => {
        console.log('Assistant Finished Speaking');
        record.stop()
        // 'close' gets called twice, wait for second
        if(speakerPass)
        {
          // Need to start a NEW conversation (interaction) -> continues 'game state' in cloud
          if(openMicAgain) config.user.assistant.start(config.conv)
          else savedState.listenForWakeWord()
        }
        else speakerPass = true
      });
    },
});




