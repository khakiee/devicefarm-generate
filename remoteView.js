function View() {
  const AWS = require('aws-sdk');
  const keys = require('./config.json');
  AWS.config.update({"accessKeyId": keys.accessKeyId,
    "secretAccessKey": keys.secretAccessKey,
    "region": 'us-west-2'});

  const devicefarm = new AWS.DeviceFarm();

  let videoSocket = null;
  let frameRequestIntervalId = null;
  let canvas = null;
  let imgContent = null;
  let state = 'opening';

  let scaleX = 1;
  let scaleY = 1;

  const minFps = 15;
  const maxFps = 30;
  const frameIntervalStepCount = 6;
  const initialFpsIntervalStepIndex = 1;

  const frameCounters = {
    intervalCounter: 0,
    requestResponseDiff: 0,
  };

  const scaleDownAtValues = linspace(Math.log(3), Math.log(5), frameIntervalStepCount - 1).map((num) => Math.round(Math.exp(num)));
  const frameIntervalSteps = linspace(Math.log(minFps), Math.log(maxFps), frameIntervalStepCount).map((num, idx) => {
    const fps = Math.exp(num);
    const frameInterval = Math.round(1000 / fps);
    return {
      frameInterval: frameInterval,
      scaleAttemptFrequency: Math.round(2000 / frameInterval),
      scaleDownAt: idx === 0 ? 2 : scaleDownAtValues[idx - 1],
      scaleUpAt: idx === (frameIntervalStepCount - 1) ? -1 : Math.round(200 / frameInterval),
    }
  });

  // Creates a vector of evenly spaced points in an interval [min, max]. https://gist.github.com/joates/6584908
  function linspace(min, max, count) {
    if (typeof count === "undefined") count = Math.max(Math.round(max - min) + 1, 1);
    if (count < 2) {
      return count === 1 ? [min] : [];
    }
    let i, ret = Array(count);
    count--;
    for (i = count; i >= 0; i--) {
      ret[i] = (i * max + (count - i) * min) / count;
    }
    return ret;
  }

  function createElements(elementId, dimensions) {
    const container = document.getElementById(elementId);

    canvas = document.createElement('canvas');
    canvas.width = dimensions.x;
    canvas.height = dimensions.y;
    canvas.setAttribute(
      'style', 'margin: 20px auto; display: block;');
    container.appendChild(canvas);

    imgContent = new Image();
    imgContent.onload = function () {
      canvas.getContext('2d').drawImage(imgContent, 0, 0, dimensions.x, dimensions.y);
    };
  }

  function initVideoSocket(endpoint, logCallback) {
    videoSocket = new WebSocket(endpoint + '&path=video');
    videoSocket.binaryType = 'arraybuffer';

    videoSocket.onopen = function () {
      logCallback(state, '[Video] Starting streaming');
      videoSocket.send('ack');
      frameCounters.requestResponseDiff++;

      initFrameRequestInterval(initialFpsIntervalStepIndex);
    };

    videoSocket.onmessage = function (evt) {
      frameCounters.requestResponseDiff--;
      const receivedMsg = evt.data;
      const arrayBufferView = new Uint8Array(receivedMsg);
      const blob = new Blob([arrayBufferView], { type: 'image/jpeg' });
      const urlCreator = window.URL || window.webkitURL;
      imgContent.src = urlCreator.createObjectURL(blob);
    };

    videoSocket.onclose = function () {
      clearInterval(frameRequestIntervalId);
      logCallback(state, '[Video] Connection is closed');
    };

    videoSocket.onerror = function () {
      clearInterval(frameRequestIntervalId);
      logCallback(state, '[Video] Connection error');
    };
  }

  function initFrameRequestInterval(intervalIndex) {
    const currentIntervalStep = frameIntervalSteps[intervalIndex];

    if (frameRequestIntervalId) {
      clearInterval(frameRequestIntervalId);
      frameCounters.intervalCounter = 0;
    }

    frameRequestIntervalId = setInterval(() => {
      const counterDiff = frameCounters.requestResponseDiff;
      frameCounters.intervalCounter++;

      if (frameCounters.intervalCounter % currentIntervalStep.scaleAttemptFrequency === 0) {

        if (counterDiff <= currentIntervalStep.scaleUpAt) {
          initFrameRequestInterval(intervalIndex + 1);
        } else if (intervalIndex !== 0 && counterDiff >= currentIntervalStep.scaleDownAt) {
          initFrameRequestInterval(intervalIndex - 1);
        }
      }

      if (counterDiff <= currentIntervalStep.scaleDownAt) {
        videoSocket.send('ack');
        frameCounters.requestResponseDiff++;
      }
    }, currentIntervalStep.frameInterval);
  }

  function initControlSocket(endpoint, logCallback, timeOut) {
    let checkStatusIntervalId;
    controlSocket = new WebSocket(endpoint + '&path=control');

    controlSocket.onopen = function () {
      logCallback(state, '[Control] Socket opened!');
      checkStatusIntervalId = setInterval(checkStatus, 2000);
    };

    controlSocket.onmessage = function (evt) {
      const receivedMsg = evt.data;
      state = 'connected';
      logCallback(state, '[Control] Message received: ' + receivedMsg);
    };

    controlSocket.onclose = function () {
      state = 'disconnected';
      logCallback(state, '[Control] Connection is closed');
      clearInterval(checkStatusIntervalId);
      setTimeout(function () {
        initControlSocket(endpoint, logCallback, timeOut);
      }, timeOut); // try to reconnect in 1 seconds
    };

    controlSocket.onerror = function () {
      state = 'disconnected';
      logCallback(state, '[Control] Connection error');
      clearInterval(checkStatusIntervalId);
    };

  function checkStatus() {
    const action = {
      message: 'StatusMessage',
      parameters: {},
    };
    // can't use sendControlMessage here since the reply from this message
    // is what confirms the connected state
    controlSocket.send(JSON.stringify(action));
    }
  }

  function sendControlMessage(message) {
    if (controlSocket && state === 'connected') {
      controlSocket.send(JSON.stringify(message));
    }
  }

  function onMouseDown(event) {
    event.preventDefault();
    addTouchListeners();
    const x = event.offsetX * scaleX;
    const y = event.offsetY * scaleY;
    const ratio = this.clientWidth / this.clientHeight;

    sendControlMessage({
      message: 'TouchDownMessage',
      parameters: { x: x, y: y, pointer: 1, pressure: 100, frame_ratio: ratio },
    });
  }

  function onMouseMove(event) {
    const x = event.offsetX * scaleX;
    const y = event.offsetY * scaleY;
    const ratio = canvas.clientWidth / canvas.clientHeight;

    sendControlMessage({
      message: 'TouchMoveMessage',
      parameters: { x: x, y: y, pointer: 1, pressure: 100, frame_ratio: ratio },
    });
  }

  function onMouseUp() {
    removeTouchListeners();
    sendControlMessage({
      message: 'TouchUpMessage',
      parameters: { pointer: 1 },
    });
  }

  function onMouseLeave() {
    removeTouchListeners();
    sendControlMessage({
      message: 'TouchUpMessage',
      parameters: { pointer: 1 },
    });
  }

  function removeTouchListeners() {
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
  }

  function addTouchListeners() {
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
  }

  function addListeners() {
    canvas.addEventListener('dragstart', function (event) {
      event.preventDefault();
    });

    canvas.addEventListener('mousedown', onMouseDown);
  }

  function sendKey(keycode) {
    sendControlMessage({
      message: 'KeyEventMessage',
      parameters: { keycode: keycode },
    });
  }

  function sendSingleChar() {
    sendKey(text.splice(0, 1)[0].charCodeAt(0));
    setTimeout(sendSingleChar.bind(this), 5000);
  }

  function getRandomString() {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < 10; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  async function initializeDevice() {
    let result = await devicefarm.createProject({name: getRandomString()}).promise();
    console.log(result);
    const projectArn = result.project.arn;

    await devicefarm.createUpload({
      name: 'netfilx.apk', /* required */
      projectArn: projectArn, /* required */
      type: 'ANDROID_APP'
    }).promise();

    result = await devicefarm.createRemoteAccessSession({
      name: getRandomString(),
      configuration: {
       billingMethod: "METERED"
      },
      deviceArn: "arn:aws:devicefarm:us-west-2::device:58D6FB12B3624256AED26D0F940D4427", // You can get the device ARN by using the list-devices CLI command.
      projectArn: projectArn// You can get the project ARN by using the list-projects CLI command.
     }).promise();
    const sessionArn = result.remoteAccessSession.arn;

    do {
      result = await devicefarm.getRemoteAccessSession({
        arn: sessionArn
      }).promise();
    } while (result.remoteAccessSession.status !== 'RUNNING');
    return result;
  }

  return {
    mount: function (settings) {
      const dimensions = {x: 600 * 3/4, y: 1024 * 3/4};
      const deviceResolution = {x: 1080,y: 1920};

      let endpoint = null;
      initializeDevice().then(function (result) {
        endpoint = result.remoteAccessSession.endpoint;
        scaleX = deviceResolution.x / dimensions.x;
        scaleY = deviceResolution.y / dimensions.y;
        createElements(settings.elementId, dimensions);
        initVideoSocket(endpoint, settings.logCallback);
        initControlSocket(endpoint, settings.logCallback, 5000);
        addListeners();
      });
    },
    sendText(inputText) { // called by beak with all text
      text = inputText.split('');
      sendSingleChar();
    }
  };
}

module.exports = View;
