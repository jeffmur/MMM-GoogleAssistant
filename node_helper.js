/** Porcupine module */
"use strict";
const path = require("path");
var NodeHelper = require("node_helper");
var savedState = undefined;
// Google Assistant + Wake Word
const Speaker = require("speaker");
const speakerHelper = require("./src/speaker-helper");
const record = require("node-record-lpcm16");
const Porcupine = require("@picovoice/porcupine-node");
const PvRecorder = require("@picovoice/pvrecorder-node");
const GoogleAssistant = require("./index"); // using custom sdk
var WakeWords = require("@picovoice/porcupine-node/builtin_keywords");
const { exec } = require("child_process");

// Logging function to log MMM-Porcupine output, in this case it is binding the
// output of the current script to the console with the [PORCUPINE] context
var _log = (function () {
  var context = "[Google Assistant]";
  return Function.prototype.bind.call(console.log, console, context);
})();

// Logging
var log = function () {
  //do nothing
};

const config = {
  debug: false,
  auth: {
    keyFilePath: path.resolve(__dirname, "src/client_secret.json"),
    savedTokensPath: path.resolve(__dirname, "src/tokens.json") // where you want the tokens to be saved
  },
  user: {
    hotwords: ["HOTWORD"], // see node_modules/@picovoice/porcupine-node/builtin_keywords.js
    hotkeys: [0],
    sensitivity: [0.5],
    handle: null, // do not edit
    assistant: null, // do not edit
    isInterrupted: false
  },
  conv: {
    deviceId: "mirror",
    deviceModelId: "Raspberry Pi",
    audio: {
      sampleRateOut: 22050, // defaults to 24000
      volumePercent: 100
    },
    lang: "en-US" // defaults to en-US, but try other ones, it's fun!
  }
};

// export functions for use elsewhere
module.exports = NodeHelper.create({
  // Start function
  start: function () {
    this.running = false;
  },

  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "INIT":
        console.log("[Google Assistant] Initializing...");
        // set the internal config to the payload received in socket notification
        config.user = payload;
        // eslint-disable-next-line no-case-declarations
        let tmp = [];
        config.user.hotwords.forEach((word) => {
          tmp.push(WakeWords.BUILTIN_KEYWORDS_STRING_TO_ENUM.get(word));
        });
        config.user.hotkeys = tmp;
        this.initialize();
        break;
      case "START":
        config.user.isInterrupted = false;
        this.activate();
        break;
      case "STOP":
        // If we get a STOP socket notification, tell Porcupine to stop listening
        config.user.isInterrupted = true;
        break;

      case "UpdateVolume":
        console.log("Recieved UpdateVolume");
        config.conv.audio.volumePercent = payload;
        break;
    }
  },

  initialize: function () {
    // if config has debug=true then start in debug mode, else dont
    var debug = config.debug ? config.debug : false;
    if (debug === true) log = _log;

    this.sendSocketNotification("GetVolume", 0); // no delay

    savedState = this;

    log("USING HOTWORDS:", config.user.hotwords);
    log("SENSITIVITY:", config.user.sensitivity);
  },

  // Tell Porcupine to start listening
  activate: function () {
    this.setupWakeWord();
  },

  // Tell Porcupine to stop listening
  deactivate: function () {
    config.user.isInterrupted = true;
  },

  // var isInterrupted = false
  setupWakeWord: function () {
    const handle = new Porcupine(config.user.hotkeys, config.user.sensitivity);
    // Default Audio Device
    // @param (default mic, 512 buffer, 1000 ms save array, )
    const recorder = new PvRecorder(-1, 512, 1000, false);
    // Note: Unhandled! Overflow - reader is not reading fast enough.
    recorder.start();
    console.log("Listening for '" + config.user.hotwords + "'...");
    this.listenForWakeWord(recorder, handle);
  },

  listenForWakeWord: async function (recorder, handle) {
    let index = -1;

    // Interrupt called when wake word is called
    const pcm = recorder.readSync();
    index = handle.process(pcm);
    // Interrupted Externally
    if (config.user.isInterrupted) {
      console.log("Interrupted.");
      clearTimeout();
      recorder.release();
    } else {
      // Wake Word NOT Detected
      if (index === -1) {
        setTimeout(() => {
          this.listenForWakeWord(recorder, handle);
        }, 0.02);
      }
      // Wake Word Detected
      else if (index !== -1) {
        clearTimeout();
        recorder.release();
        this.startAssistant();
      }
    }
  },

  startAssistant: function () {
    // prompt the user to start talking
    exec("play modules/MMM-GoogleAssistant/start_assistant.wav");
    // UI update
    savedState.sendSocketNotification("ON_CONVERSATION_UPDATE", "");
    // Google Assistant
    const assistant = new GoogleAssistant(config.auth);
    config.user.assistant = assistant;
    // console.log(config.conv.audio);
    assistant
      .on("ready", () => {
        // start a conversation!
        assistant.start(config.conv);
      })
      .on("started", this.startConversation)
      .on("error", (error) => {
        console.log("Assistant Error:", error);
        record.stop();
        // speaker.end();
      });
  },

  startConversation: function (conv) {
    const conversation = conv;
    // console.log(conversation);
    console.log("Say something!");
    let openMicAgain = false; // continue 'conversation'
    let speakerPass = false; // event gets called twice

    // set up the microphone
    const mic = record.start({ threshold: 0, recordProgram: "arecord" });

    // setup the speaker
    const speaker = new Speaker({
      channels: 1,
      sampleRate: config.conv.audio.sampleRateOut
    });
    speakerHelper.init(speaker);
    // setup the conversation
    // this == conversation
    conversation
      // send the audio buffer to the speaker
      .on("audio-data", (data) => {
        speakerHelper.update(data);
      })
      // done speaking, close the mic
      .on("end-of-utterance", () => record.stop())
      // just to spit out to the console what was said (as we say it)
      .on("transcription", (data) => {
        console.log(
          "Transcription:",
          data.transcription,
          " --- Done:",
          data.done
        );
        savedState.sendSocketNotification(
          "ON_CONVERSATION_UPDATE",
          data.transcription
        );
      }) //data.done
      // what the assistant said back
      .on("response", (text) => console.log("Assistant Text Response:", text))
      // the device needs to complete an action
      .on("device-action", (data) => savedState.handleLocalIntent(data))
      // fetch volume from MMM-DeviceControl
      .on("volume-percent", (current) => {
        // console.log(current);
        // savedState.sendSocketNotification("GetVolume", 0); // delay
        // can use this for UI instead...
      })
      // once the conversation is ended, see if we need to follow up
      .on("ended", (error, continueConversation) => {
        if (error) console.log("End Conversation Error: ", error);
        else if (continueConversation === true) openMicAgain = true;
        else {
          savedState.sendSocketNotification(
            "ON_CONVERSATION_FINISH",
            undefined
          );
        }
      })
      // catch any errors
      .on("error", (error) => {
        console.log("Streaming Conversation Error:", error);
        savedState.setupWakeWord();
      });

    // pass the mic audio to the assistant
    mic.on("data", (data) => {
      speakerHelper.open();
      conversation.write(data);
    });

    speaker
      .on("open", () => {
        record.stop();
        console.log("Assistant Speaking");
        speakerHelper.open();
      })
      .on("close", () => {
        console.log("Assistant Finished Speaking");
        record.stop();
        // 'close' gets called twice, wait for second
        if (speakerPass) {
          // Need to start a NEW conversation (interaction) -> continues 'game state' in cloud
          if (openMicAgain) config.user.assistant.start(config.conv);
          else savedState.setupWakeWord();
        } else speakerPass = true;
      });
  },

  /**
   * Send EXECUTE commands to MMM-DeviceControl
   * Then submit response header to Google Assistant?
   *
   * @param {*} data
   */
  handleLocalIntent: async function (data) {
    const intent = data.inputs[0].intent;
    // console.log(intent);
    const payload = data.inputs[0].payload;
    // console.log(payload);
    const execute = payload.commands[0].execution;
    const command = String(execute[0].command);
    const params = execute[0].params;
    // local intent ONLY
    if (intent === "action.devices.EXECUTE") {
      switch (command) {
        case "action.devices.commands.SetVolume":
          // change conversation config var
          // update volume on Firebase
          if (
            params.volumeLevel !== 0 &&
            params.volumeLevel !== config.conv.audio.volumePercent
          ) {
            savedState.sendSocketNotification("SetVolume", params);
            config.conv.audio.volumePercent = params.volumeLevel;
          }
          break;
        case "action.devices.commands.Mute": // handled by cloud function
          console.log(params);
          break;
        case "action.devices.commands.VolumeRelative":
          // ex. { isPercentage: true, volumeRelativeLevel: -10 }
          // Negative value will subtract, Positive will be added
          console.log(params);
          if (params.isPercentage) {
            config.conv.audio.volumePercent += params.volumeRelativeLevel;
            savedState.sendSocketNotification(
              "SetRelativeVolume",
              config.conv.audio.volumePercent
            );
          }
          break;
        case "action.devices.commands.OnOff": // handled by cloud function
          break;
      }
    } else {
      console.log("[WARN] Intent Not Implemented!" + intent);
    }
  }
});
