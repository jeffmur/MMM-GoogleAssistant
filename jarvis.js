// Google Assistant + Wake Word
"use strict";
const path = require("path");
const Speaker = require("speaker");
const speakerHelper = require("./src/speaker-helper");
const record = require("node-record-lpcm16");
const Porcupine = require("@picovoice/porcupine-node");
const PvRecorder = require("@picovoice/pvrecorder-node");
const GoogleAssistant = require("./index"); // using custom sdk
const WakeWords = require("@picovoice/porcupine-node/builtin_keywords");

const config = {
  debug: false,
  auth: {
    keyFilePath: path.resolve(__dirname, "src/client_secret.json"),
    savedTokensPath: path.resolve(__dirname, "src/tokens.json") // where you want the tokens to be saved
  },
  user: {
    hotwords: ["JARVIS"], // see node_modules/@picovoice/porcupine-node/builtin_keywords.js
    hotkeys: [0],
    sensitivity: [0.5],
    handle: null, // do not edit
    assistant: null, // do not edit
    conversation: null
  },
  conv: {
    audio: {
      sampleRateOut: 24000 // defaults to 24000
    },
    lang: "en-US" // defaults to en-US, but try other ones, it's fun!
  }
};

/* Porcupine + Google Assistant
 * listenForWakeWord()
 * Details:
 *
 */
var isInterrupted = false;
/**
 *
 */
function setupWakeWord() {
  let handle = new Porcupine([WakeWords.JARVIS], [0.5]);
  config.user.handle = handle;
  // Default Audio Device
  // @param (default mic, 512 buffer, 1000 ms save array, )
  const recorder = new PvRecorder(-1, 512, 1000, false);
  recorder.start();
  console.log("Listening for '" + config.user.hotwords + "'...");
  listenForWakeWord(recorder, handle);
}

/**
 * @param recorder
 * @param handle
 */
async function listenForWakeWord(recorder, handle) {
  let index = -1;
  // this.running = true

  // Interrupt called when wake word is called
  const pcm = await recorder.read();
  index = handle.process(pcm);
  // Interrupted Externally
  if (isInterrupted) {
    recorder.release();
    return;
  }
  // Wake Word NOT Detected
  if (index === -1) {
    setTimeout(() => {
      listenForWakeWord(recorder, handle);
    }, 1);
  }
  // Wake Word Detected
  else {
    isInterrupted = true;
    recorder.release();
    startAssistant();
  }
}

/**
 *
 */
function startAssistant() {
  exec("play modules/MMM-GoogleAssistant/Jarvis_Wake.wav");
  // Google Assistant
  const assistant = new GoogleAssistant(config.auth);
  config.user.assistant = assistant;
  assistant
    .on("ready", () => {
      // start a conversation!
      assistant.start(config.conv);
    })
    .on("started", startConversation)
    .on("error", (error) => {
      console.log("Assistant Error:", error);
      record.stop();
      // speaker.end();
    });
}

/**
 * @param conversation
 */
function startConversation(conversation) {
  console.log("Say something!");
  let openMicAgain = false; // continue 'conversation'
  let speakerPass = false; // event gets called twice
  // setup the conversation
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
      // savedState.sendSocketNotification("ON_CONVERSATION_UPDATE", data.transcription)
    }) //data.done
    // what the assistant said back
    .on("response", (text) => console.log("Assistant Text Response:", text))
    // if we've requested a volume level change, get the percentage of the new level
    .on("devices", (percent) => console.log("SYNC EVENT"))
    // the device needs to complete an action
    .on("device-action", (data) => handleLocalIntent(data))

    .on("volume-percent", (percent) => {
      console.log("Volume: " + percent);
      // do stuff with a volume percent change (range from 1-100)
    })

    // once the conversation is ended, see if we need to follow up
    .on("ended", (error, continueConversation) => {
      if (error) console.log("End Conversation Error: ", error);
      else if (continueConversation === true) openMicAgain = true;
      // console.log(response);
      // conversation.write(response);
      // else savedState.sendSocketNotification("ON_CONVERSATION_FINISH", undefined)
    })
    // catch any errors
    .on("error", (error) => {
      console.log("Steaming Conversation Error:", error);
    });

  // pass the mic audio to the assistant
  const mic = record.start({ threshold: 0, recordProgram: "arecord" });
  mic.on("data", (data) => {
    conversation.write(data);
  });

  // setup the speaker
  const speaker = new Speaker({
    channels: 1,
    sampleRate: config.conv.audio.sampleRateOut
  });
  speakerHelper.init(speaker);
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
        else setupWakeWord();
      } else speakerPass = true;
    });
}

const {
  get_sensor_status,
  set_status,
  sleep
} = require("/home/pi/MagicMirror/modules/MMM-DeviceControl/index.js");
const { exec } = require("shelljs");

/**
 * Send EXECUTE commands to MMM-DeviceControl
 * Then submit response header to Google Assistant?
 *
 * @param {*} data
 */
function handleLocalIntent(data) {
  console.log(data);
  /**
  request is:
  execution:
  {
    command: 'action.devices.commands.SetVolume',
    params: { isPercentage: true, volumeLevel: 0 }
  }
   */
  var intent = data.inputs[0].intent;
  // console.log(intent);
  var payload = data.inputs[0].payload;
  // console.log(payload);
  var execute = payload.commands[0].execution;
  var command = String(execute[0].command);
  var params = execute[0].params;
  // local intent ONLY
  if (intent === "action.devices.EXECUTE") {
    switch (command) {
      case "action.devices.commands.SetVolume":
        console.log(params);
        get_sensor_status("volumeLevel").then((current) => {
          // TODO
          if (params.volumeLevel === 0) {
            set_status("mute", true);
          }
          if (params.isPercentage) {
            set_status("volumeLevel", params.volumeLevel);
          }
        });
        break;

      case "action.devices.commands.OnOff":
        break;
    }
  }
}

setupWakeWord();
// startAssistant();
