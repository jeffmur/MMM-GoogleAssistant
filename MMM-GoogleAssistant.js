// Module : MMM-Assistant

Module.register("MMM-GoogleAssistant", {
  defaults: {
    debug: true,
    // MUST BE IN ALL CAPS for mapping
    // Find all hotwords in src/google-helper.js
    hotword: "",
    sensitivity: 0,
    updateDelay: 100
  },

  start: function () {
    this.config = this.configAssignment({}, this.defaults, this.config);
    this.assistantActive = false;
    this.processing = false;
    this.userQuery = null;
    this.sendSocketNotification("INIT", this.config);
  },

  getDom: function () {
    Log.log("Updating DOM for GA");
    var wrapper = document.createElement("div");

    if (this.assistantActive) {
      if (this.processing) {
        wrapper.innerHTML =
          "<img src='modules/MMM-GoogleAssistant/pub/listen.gif' width=100px height=auto></img><br/>" +
          this.userQuery;
      } else {
        wrapper.innerHTML =
          "<img src='modules/MMM-GoogleAssistant/pub/assistant_active.png'></img>";
      }
    } else {
      wrapper.innerHTML =
        "<img src='modules/MMM-GoogleAssistant/pub/assistant_inactive.png'></img>";
    }
    return wrapper;
  },

  // notification from other modules
  notificationReceived: function (notification, payload, sender) {
    if (sender === undefined) return;
    if (sender.name === "MMM-DeviceControl") {
      switch (notification) {
        case "GetVolume":
          this.sendSocketNotification("UpdateVolume", payload);
      }
    }
    if (sender.name === "MMM-ProfileSwitcher") {
      switch (notification) {
        case "ASSISTANT_START":
          console.log("Sent socket notification");
          this.sendSocketNotification("START", null);
          break;
        case "ASSISTANT_STOP":
          this.sendSocketNotification("STOP", null);
          break;
      }
    }
  },

  // When node_helper sends the socket notification and it is recieved
  // here
  socketNotificationReceived: function (notification, payload) {
    let delay = this.config.updateDelay;
    switch (notification) {
      // Local Intent
      case "SetRelativeVolume":
        this.sendNotification("SetRelativeVolume", payload); // new volume (in percent)
        break;
      case "SetVolume":
        this.sendNotification("SetVolume", payload); // contains {isPercentage: true | false, volumeLevel: 0-100}
        break;
      case "GetVolume":
        this.sendNotification("GetVolume", payload); // holding delay
        break;
      case "ON_CONVERSATION_UPDATE":
        this.assistantActive = true;
        this.processing = true;
        this.userQuery = payload;
        delay = 50;
        break;
      case "WAKEWORD_DETECTED":
        this.assistantActive = true;
        this.processing = false;
        delay = 0;
        break;
      case "ON_CONVERSATION_FINISH":
        this.assistantActive = false;
        this.processing = false;
        delay = 2000;
        break;
    }
    this.updateDom(delay);
  },

  // Assign the configuration
  configAssignment: function (result) {
    var stack = Array.prototype.slice.call(arguments, 1);
    var item;
    var key;
    while (stack.length) {
      item = stack.shift();
      for (key in item) {
        if (item.hasOwnProperty(key)) {
          if (
            typeof result[key] === "object" &&
            result[key] &&
            Object.prototype.toString.call(result[key]) !== "[object Array]"
          ) {
            if (typeof item[key] === "object" && item[key] !== null) {
              result[key] = this.configAssignment({}, result[key], item[key]);
            } else {
              result[key] = item[key];
            }
          } else {
            result[key] = item[key];
          }
        }
      }
    }
    return result;
  }
});
