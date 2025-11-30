// CreamLine 1.0.9 - renderer
// WebRTC + WebSocket signalling, auto-room room-1,
// индикаторы онлайна, пинг-понг, выбор устройств и прослушка себя.

const SIGNALING_URL = (window.electronAPI && window.electronAPI.signalingUrl) || 'ws://185.181.165.175:8080'; // поменяй при необходимости
const ROOM_NAME = (window.electronAPI && window.electronAPI.roomName) || 'room-1';

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
let remoteMediaStream = null;

let selfListenCheckbox;
let micSelect;
let outSelect;

let fullscreenButtons;

let localAudioEl;
let remoteAudioEl;
let checkUpdatesBtn;
let connectionLogEl;
let headerLogo;

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
  console.log('[CreamLine]', ...args);
}

function appendLog(message) {
  log(message);
  if (!connectionLogEl) return;
  const div = document.createElement('div');
  div.className = 'entry';
  const ts = new Date().toLocaleTimeString();
  div.textContent = `[${ts}] ${message}`;
  connectionLogEl.appendChild(div);
  connectionLogEl.scrollTop = connectionLogEl.scrollHeight;
}

function safeSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  obj.senderId = myId; // Добавляем ID отправителя для разрешения коллизий
  ws.send(JSON.stringify(obj));
}

function sendPendingOffer() {
  if (!pc || !pc.localDescription) return;
  if (pc.localDescription.type !== 'offer') return;
  if (pc.signalingState !== 'have-local-offer') return;
  safeSend({ type: 'offer', sdp: pc.localDescription, room: ROOM_NAME });
}

// ---- WebSocket ----
function setupWebSocket() {
  setDot(meDot, 'offline');
  appendLog(`Подключаемся к ${SIGNALING_URL}, комната ${ROOM_NAME}`);
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    appendLog(`WS open: ${SIGNALING_URL}, room=${ROOM_NAME}`);
    setDot(meDot, 'online');
    // Авто-join в room-1
    safeSend({ type: 'join', room: ROOM_NAME });
    sendPendingOffer();
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
        appendLog(`Welcome, id=${myId}, room=${msg.room}`);
        break;

      case 'peers':
        {
          const prevCount = peersCount;
          peersCount = msg.count || 0;
          appendLog(`Peers in room: ${peersCount} (${(msg.ids || []).join(', ')})`);
          if (prevCount !== 0 && peersCount > prevCount) {
            appendLog('Кто-то подключился');
          } else if (prevCount !== 0 && peersCount < prevCount) {
            appendLog('Кто-то отключился');
          }
        }
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
        handleRemoteState(msg);
        break;

      default:
        log('Unknown WS message', msg);
    }
  };

  ws.onclose = () => {
    log('WS closed');
    appendLog('WS closed, пробую переподключиться через 3s');
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

  remoteMediaStream = new MediaStream();
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

    log('Got remote track:', event.track.kind, 'Stream id:', stream.id);

    // Если в стриме есть видео-трек — это экран (даже если там есть и аудио)
    if (stream.getVideoTracks().length > 0) {
      if (remoteVideo && remoteVideo.srcObject !== stream) {
        remoteVideo.srcObject = stream;
        log('Assigned to remoteVideo');
      }
    } else {
      // Иначе считаем, что это микрофон (аудио-онли)
      if (remoteAudioEl && remoteAudioEl.srcObject !== stream) {
        remoteAudioEl.srcObject = stream;
        log('Assigned to remoteAudioEl');
      }
    }
  };

  pc.onconnectionstatechange = () => {
    log('connection state:', pc.connectionState);
    updateFriendDotFromPC();
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
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

  // "Polite" peer = тот, у кого ID меньше (лексикографически)
  const polite = (myId || '') < (msg.senderId || '');

  ignoreOffer = !polite && offerCollision;

  if (ignoreOffer) {
    log('Ignoring offer (collision, impolite)');
    return;
  }

  if (offerCollision) {
    // Мы polite, уступаем. Откатываемся, чтобы принять их оффер.
    log('Collision detected, rolling back (polite)');
    try {
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      ]);
    } catch (e) {
      console.error('Rollback/SRD error', e);
    }
  } else {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (e) {
      console.error('setRemoteDescription error', e);
    }
  }

  // Отвечаем на offer
  try {
    if (pc.signalingState === 'have-remote-offer') {
      await pc.setLocalDescription();
      safeSend({ type: 'answer', sdp: pc.localDescription, room: ROOM_NAME });
    }
  } catch (e) {
    console.error('createAnswer error', e);
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
    if (!ignoreOffer) {
      console.error('addIceCandidate error', e);
    }
  }
}

function handleRemoteState(msg) {
  log('Remote state:', msg);
  if (msg.screen === 'off') {
    if (remoteVideo) {
      remoteVideo.srcObject = null;
    }
    // Также можно очистить remoteAudioEl, если нужно
    // if (remoteAudioEl) remoteAudioEl.srcObject = null;
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

function renderSourcePicker(sources) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 16px;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #1c1c1c;
      color: #f5f5f5;
      border: 1px solid #333;
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      width: 90%;
      max-width: 960px;
      max-height: 80vh;
      overflow: auto;
      padding: 16px;
      font-family: sans-serif;
    `;

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px;';
    const title = document.createElement('h3');
    title.textContent = 'Выберите окно или экран для трансляции';
    title.style.margin = '0';
    const cancelTop = document.createElement('button');
    cancelTop.textContent = 'Отмена';
    cancelTop.style.cssText = `
      background: transparent;
      color: #f5f5f5;
      border: 1px solid #666;
      padding: 6px 10px;
      cursor: pointer;
    `;
    cancelTop.onclick = () => {
      cleanup();
      resolve(null);
    };
    titleRow.appendChild(title);
    titleRow.appendChild(cancelTop);

    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 12px;
    `;

    sources.forEach((source) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.style.cssText = `
        background: #222;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 8px;
        text-align: left;
        cursor: pointer;
        color: #f5f5f5;
        transition: border-color 0.15s ease, transform 0.15s ease;
      `;
      card.onmouseenter = () => {
        card.style.borderColor = '#e74c3c';
        card.style.transform = 'translateY(-2px)';
      };
      card.onmouseleave = () => {
        card.style.borderColor = '#333';
        card.style.transform = 'none';
      };

      const thumb = document.createElement('div');
      thumb.style.cssText = `
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #111;
        border-radius: 6px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 8px;
      `;
      if (source.thumbnail) {
        const img = document.createElement('img');
        img.src = source.thumbnail;
        img.alt = source.name || 'Источник';
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
        thumb.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.textContent = 'Без превью';
        placeholder.style.cssText = 'color: #777; font-size: 13px;';
        thumb.appendChild(placeholder);
      }

      const label = document.createElement('div');
      label.textContent = source.name || 'Источник';
      label.style.cssText = 'font-size: 13px; line-height: 1.4;';

      card.appendChild(thumb);
      card.appendChild(label);

      card.onclick = () => {
        cleanup();
        resolve(source);
      };

      grid.appendChild(card);
    });

    const cancelBottom = document.createElement('button');
    cancelBottom.textContent = 'Отмена';
    cancelBottom.style.cssText = `
      margin-top: 12px;
      background: transparent;
      color: #f5f5f5;
      border: 1px solid #666;
      padding: 8px 12px;
      cursor: pointer;
    `;
    cancelBottom.onclick = () => {
      cleanup();
      resolve(null);
    };

    modal.appendChild(titleRow);
    modal.appendChild(grid);
    modal.appendChild(cancelBottom);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (evt) => {
      if (evt.target === overlay) {
        cleanup();
        resolve(null);
      }
    });

    function cleanup() {
      overlay.remove();
    }

    document.body.appendChild(overlay);
  });
}

async function captureScreenStream() {
  if (!window.electronAPI || !window.electronAPI.getSources) {
    throw new Error('desktopCapturer bridge is not available (preload failed)');
  }

  const sources = await window.electronAPI.getSources();
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('desktopCapturer returned no sources');
  }

  const selectedSource = await renderSourcePicker(sources);
  if (!selectedSource || !selectedSource.id) return null;

  return await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: selectedSource.id,
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: selectedSource.id,
        maxFrameRate: 60,
      }
    }
  });
}

async function startScreen() {
  try {
    const stream = await captureScreenStream();
    if (!stream) {
      appendLog('Выбор источника экрана отменен');
      return;
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
  const stream = localScreenStream;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }

  if (pc && stream) {
    stream.getTracks().forEach(track => {
      const sender = pc.getSenders().find(s => s.track === track);
      if (sender) {
        pc.removeTrack(sender);
      }
    });
  }

  localScreenStream = null;

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
    const vol = value / 100;
    if (remoteAudioEl) remoteAudioEl.volume = vol;
    if (remoteVideo) remoteVideo.volume = vol;
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

// ---- обработка событий обновления ----
if (window.electronAPI && window.electronAPI.onUpdateProgress) {
  window.electronAPI.onUpdateProgress((percent) => {
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = true;
      checkUpdatesBtn.textContent = `Скачивание: ${percent}%`;
    }
  });
}

if (window.electronAPI && window.electronAPI.onUpdateError) {
  window.electronAPI.onUpdateError((err) => {
    console.error('Update error from main:', err);
    alert(`Ошибка при скачивании обновления: ${err}`);
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.textContent = 'Проверить обновления';
    }
  });
}

// ---- старт приложения ----



window.addEventListener('DOMContentLoaded', async () => {
  log('electronAPI available:', !!window.electronAPI, 'getSources:', !!(window.electronAPI && window.electronAPI.getSources));
  // заполняем ссылки на DOM
  btnStartScreen = document.getElementById('startScreen');
  btnStopScreen = document.getElementById('stopScreen');
  btnMicOn = document.getElementById('micOn');
  btnMicOff = document.getElementById('micOff');
  checkUpdatesBtn = document.getElementById('checkUpdates');

  meDot = document.getElementById('me-dot');
  friendDot = document.getElementById('friend-dot');

  localVideo = document.getElementById('localScreen');
  remoteVideo = document.getElementById('remoteScreen');
  remoteVolume = document.getElementById('remoteScreenVolume');

  selfListenCheckbox = document.getElementById('selfListen');
  micSelect = document.getElementById('micSelect');
  outSelect = document.getElementById('outSelect');

  fullscreenButtons = document.querySelectorAll('.fullscreen-btn');

  localAudioEl = document.getElementById('localAudio');
  remoteAudioEl = document.getElementById('remoteAudio');
  connectionLogEl = document.getElementById('connection-log');
  headerLogo = document.getElementById('header-logo');

  setDot(meDot, 'offline');
  setDot(friendDot, 'offline');

  if (btnMicOff) btnMicOff.disabled = true;
  if (btnStopScreen) btnStopScreen.disabled = true;

  if (headerLogo) {
    if (window.paths && window.paths.logo) {
      headerLogo.src = window.paths.logo;
    } else {
      headerLogo.src = 'build/name.png';
    }
  }

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

  await startMic();
  await populateDevices();
  setupFullscreenButtons();
  setupRemoteVolume();
  setupSelfListen();
  setupWebSocket();
  appendLog(`Конфиг: signaling=${SIGNALING_URL}, room=${ROOM_NAME}`);
});
