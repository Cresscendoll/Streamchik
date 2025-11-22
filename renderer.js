// streamchik 1.0.1 — renderer
// WebRTC + WebSocket signalling, auto-room room-1,
// индикаторы онлайна, пинг-понг, выбор устройств и прослушка себя.

const SIGNALING_URL = (window.electronAPI && window.electronAPI.signalingUrl) || 'ws://91.219.61.150:8080'; // поменяй при необходимости
const ROOM_NAME = 'room-1';

// ---- DOM (заполним после DOMContentLoaded) ----
let btnStartScreen;
let btnStopScreen;
let btnMicOn;
let btnMicOff;

let meDot;
let friendDot;

let localVideo;
let remoteVideo;
let remoteVolume;

let selfListenCheckbox;
let micSelect;
let outSelect;

let fullscreenButtons;

let localAudioEl;
let remoteAudioEl;
let checkUpdatesBtn;

// ---- состояние ----
let ws = null;
let myId = null;
let peersCount = 0;

let pc = null;
let localScreenStream = null;
let localMicStream = null;

let makingOffer = false;
let ignoreOffer = false;

// ---- утилиты UI ----
function setDot(elem, status) {
  if (!elem) return;
  const validStatuses = ['online', 'offline'];
  elem.classList.remove(...validStatuses);
  if (validStatuses.includes(status)) {
    elem.classList.add(status);
  }
}

function updateFriendDotFromPC() {
  if (!pc) return;
  switch (pc.connectionState) {
    case 'connected':
      setDot(friendDot, 'online');
      break;
    default:
      setDot(friendDot, 'offline');
  }
}

function log(...args) {
  console.log('[streamchik]', ...args);
}

function safeSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

// ---- WebSocket ----
function setupWebSocket() {
  setDot(meDot, 'offline');
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    log('WS open');
    setDot(meDot, 'online');
    // Авто-join в room-1
    safeSend({ type: 'join', room: ROOM_NAME });
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      log('Bad WS message', event.data);
      return;
    }

    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        log('Welcome, id=', myId, 'room=', msg.room);
        break;

      case 'peers':
        peersCount = msg.count || 0;
        log('Peers in room:', peersCount, msg.ids);
        // зеленый если в комнате есть второй участник, иначе красный
        setDot(friendDot, peersCount > 1 ? 'online' : 'offline');
        break;

      case 'ping':
        safeSend({ type: 'pong', ts: msg.ts });
        break;

      case 'offer':
        await handleOffer(msg);
        break;

      case 'answer':
        await handleAnswer(msg);
        break;

      case 'ice':
        await handleRemoteIce(msg);
        break;

      case 'state':
        // На будущее — можно обновлять UI, пока просто логируем
        log('Remote state:', msg);
        break;

      default:
        log('Unknown WS message', msg);
    }
  };

  ws.onclose = () => {
    log('WS closed');
    setDot(meDot, 'offline');
    setDot(friendDot, 'offline');
    // попробуем переподключиться
    setTimeout(setupWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WS error', SIGNALING_URL, err);
  };
}

// ---- WebRTC ----
function ensurePeerConnection() {
  if (pc) return;

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      safeSend({ type: 'ice', candidate: event.candidate, room: ROOM_NAME });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;

    if (remoteVideo) remoteVideo.srcObject = stream;
    if (remoteAudioEl) remoteAudioEl.srcObject = stream;
    log('Got remote track');
  };

  pc.onconnectionstatechange = () => {
    log('connection state:', pc.connectionState);
    updateFriendDotFromPC();
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      safeSend({ type: 'offer', sdp: pc.localDescription, room: ROOM_NAME });
    } catch (e) {
      console.error('onnegotiationneeded error', e);
    } finally {
      makingOffer = false;
    }
  };
}

async function handleOffer(msg) {
  ensurePeerConnection();

  const offerCollision =
    makingOffer || (pc.signalingState !== 'stable');

  ignoreOffer = !offerCollision && msg.polite === false;

  if (ignoreOffer) {
    log('Ignoring offer (collision)');
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    safeSend({ type: 'answer', sdp: pc.localDescription, room: ROOM_NAME });
  } catch (e) {
    console.error('handleOffer error', e);
  }
}

async function handleAnswer(msg) {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  } catch (e) {
    console.error('handleAnswer error', e);
  }
}

async function handleRemoteIce(msg) {
  if (!pc || !msg.candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch (e) {
    console.error('addIceCandidate error', e);
  }
}

// ---- медиа ----
async function startMic() {
  try {
    const constraints = {
      audio: {
        deviceId: micSelect && micSelect.value && micSelect.value !== 'default'
          ? { exact: micSelect.value }
          : undefined,
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localMicStream = stream;
    if (localAudioEl) {
      localAudioEl.srcObject = stream;
      localAudioEl.muted = !(selfListenCheckbox && selfListenCheckbox.checked);
    }

    ensurePeerConnection();
    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    if (btnMicOn) btnMicOn.disabled = true;
    if (btnMicOff) btnMicOff.disabled = false;
  } catch (e) {
    console.error('startMic error', e);
    alert('Не удалось включить микрофон');
  }
}

function stopMic() {
  if (localMicStream) {
    localMicStream.getTracks().forEach(t => t.stop());
    localMicStream = null;
  }
  if (pc) {
    pc.getSenders()
      .filter(s => s.track && s.track.kind === 'audio')
      .forEach(s => pc.removeTrack(s));
  }
  if (localAudioEl) localAudioEl.srcObject = null;
  if (btnMicOn) btnMicOn.disabled = false;
  if (btnMicOff) btnMicOff.disabled = true;
}

async function captureScreenStream() {
  const baseVideo = { frameRate: 60 };

  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: baseVideo,
      audio: {
        selfBrowserSurface: 'include',
        systemAudio: 'include',
        suppressLocalAudioPlayback: false,
      },
    });
  } catch (err) {
    console.warn('getDisplayMedia with audio failed, retrying without audio', err);
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: baseVideo,
      audio: false,
    });
  } catch (err) {
    console.warn('getDisplayMedia without audio failed, trying desktopCapturer', err);
  }

  return await captureViaDesktopCapturer();
}

async function captureViaDesktopCapturer() {
  if (!window.electronAPI || !window.electronAPI.getSources) {
    throw new Error('desktopCapturer is not available');
  }

  const sources = await window.electronAPI.getSources();
  const screenSource = Array.isArray(sources)
    ? (sources.find((s) => typeof s?.id === 'string' && s.id.toLowerCase().includes('screen')) || sources[0])
    : null;

  if (!screenSource || !screenSource.id) {
    throw new Error('Не найден ни один экран для захвата');
  }

  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: screenSource.id,
        maxFrameRate: 60,
      }
    }
  });
}

async function startScreen() {
  try {
    const stream = await captureScreenStream();
    if (!stream) {
      throw new Error('Не удалось получить захват экрана');
    }

    localScreenStream = stream;
    if (localVideo) localVideo.srcObject = stream;

    ensurePeerConnection();
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    if (btnStartScreen) btnStartScreen.disabled = true;
    if (btnStopScreen) btnStopScreen.disabled = false;

    safeSend({ type: 'state', screen: 'on', room: ROOM_NAME });
  } catch (e) {
    console.error('startScreen error', e);
    const detail = e && e.message ? `\n\n${e.message}` : '';
    alert(`Не удалось запустить стрим.${detail}`);
  }
}

function stopScreen() {
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(t => t.stop());
    localScreenStream = null;
  }

  if (pc) {
    pc.getSenders()
      .filter(s => s.track && s.track.kind === 'video')
      .forEach(s => pc.removeTrack(s));
  }

  if (localVideo) localVideo.srcObject = null;

  if (btnStartScreen) btnStartScreen.disabled = false;
  if (btnStopScreen) btnStopScreen.disabled = true;

  safeSend({ type: 'state', screen: 'off', room: ROOM_NAME });
}

// ---- устройства ввода / вывода ----
async function populateDevices() {
  if (!micSelect || !outSelect) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    micSelect.innerHTML = '';
    outSelect.innerHTML = '';

    const defaultMicOption = document.createElement('option');
    defaultMicOption.value = 'default';
    defaultMicOption.textContent = 'Системный по умолчанию';
    micSelect.appendChild(defaultMicOption);

    const defaultOutOption = document.createElement('option');
    defaultOutOption.value = 'default';
    defaultOutOption.textContent = 'Системный по умолчанию';
    outSelect.appendChild(defaultOutOption);

    devices.forEach((d) => {
      const option = document.createElement('option');
      option.value = d.deviceId;
      option.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 4)}...)`;

      if (d.kind === 'audioinput') {
        micSelect.appendChild(option);
      } else if (d.kind === 'audiooutput') {
        outSelect.appendChild(option);
      }
    });
  } catch (e) {
    console.error('enumerateDevices error', e);
  }
}

async function applyOutputDevice() {
  if (!remoteAudioEl || !localAudioEl) return;
  if (!('setSinkId' in HTMLMediaElement.prototype)) {
    console.warn('setSinkId не поддерживается');
    return;
  }
  const deviceId = outSelect ? outSelect.value : 'default';
  try {
    if (deviceId && deviceId !== 'default') {
      await remoteAudioEl.setSinkId(deviceId);
      await localAudioEl.setSinkId(deviceId);
    } else {
      await remoteAudioEl.setSinkId('');
      await localAudioEl.setSinkId('');
    }
  } catch (e) {
    console.error('setSinkId error', e);
  }
}

// ---- fullscreen ----
function setupFullscreenButtons() {
  if (!fullscreenButtons) return;
  fullscreenButtons.forEach((btn) => {
    const targetId = btn.dataset.target;
    const videoEl = document.getElementById(targetId);
    if (!videoEl) return;

    btn.addEventListener('click', () => {
      if (videoEl.requestFullscreen) {
        videoEl.requestFullscreen();
      }
    });
  });
}

// ---- громкость удалённого экрана ----
function setupRemoteVolume() {
  if (!remoteVolume || !remoteAudioEl) return;
  remoteVolume.addEventListener('input', () => {
    const value = Number(remoteVolume.value || 0);
    remoteAudioEl.volume = value / 100;
  });
}

// ---- прослушать себя ----
function setupSelfListen() {
  if (!selfListenCheckbox || !localAudioEl) return;
  selfListenCheckbox.addEventListener('change', () => {
    localAudioEl.muted = !selfListenCheckbox.checked;
  });
}

async function handleUpdateCheck() {
  if (!window.electronAPI || !window.electronAPI.checkForUpdates) {
    alert('Проверка обновлений недоступна в этой сборке.');
    return;
  }

  const originalText = checkUpdatesBtn ? checkUpdatesBtn.textContent : '';
  if (checkUpdatesBtn) {
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = 'Проверяем...';
  }

  try {
    await window.electronAPI.checkForUpdates();
  } catch (e) {
    console.error('checkForUpdates error', e);
    const detail = e && e.message ? `\n\n${e.message}` : '';
    alert(`Не удалось проверить обновления.${detail}`);
  } finally {
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.textContent = originalText || 'Проверить обновления';
    }
  }
}

// ---- старт приложения ----



window.addEventListener('DOMContentLoaded', async () => {
  // заполняем ссылки на DOM
  btnStartScreen = document.getElementById('startScreen');
  btnStopScreen  = document.getElementById('stopScreen');
  btnMicOn       = document.getElementById('micOn');
  btnMicOff      = document.getElementById('micOff');
  checkUpdatesBtn = document.getElementById('checkUpdates');

  meDot          = document.getElementById('me-dot');
  friendDot      = document.getElementById('friend-dot');

  localVideo     = document.getElementById('localScreen');
  remoteVideo    = document.getElementById('remoteScreen');
  remoteVolume   = document.getElementById('remoteScreenVolume');

  selfListenCheckbox = document.getElementById('selfListen');
  micSelect      = document.getElementById('micSelect');
  outSelect      = document.getElementById('outSelect');

  fullscreenButtons = document.querySelectorAll('.fullscreen-btn');

  localAudioEl   = document.getElementById('localAudio');
  remoteAudioEl  = document.getElementById('remoteAudio');

  setDot(meDot, 'offline');
  setDot(friendDot, 'offline');

  if (btnMicOff) btnMicOff.disabled = true;
  if (btnStopScreen) btnStopScreen.disabled = true;

  if (btnMicOn) btnMicOn.addEventListener('click', startMic);
  if (btnMicOff) btnMicOff.addEventListener('click', stopMic);
  if (btnStartScreen) btnStartScreen.addEventListener('click', startScreen);
  if (btnStopScreen) btnStopScreen.addEventListener('click', stopScreen);
  if (checkUpdatesBtn) checkUpdatesBtn.addEventListener('click', handleUpdateCheck);

  if (micSelect) {
    micSelect.addEventListener('change', () => {
      if (localMicStream) {
        stopMic();
        startMic();
      }
    });
  }

  if (outSelect) {
    outSelect.addEventListener('change', () => {
      applyOutputDevice();
    });
  }

  await populateDevices();
  setupFullscreenButtons();
  setupRemoteVolume();
  setupSelfListen();
  setupWebSocket();
});
