// ===============================
//  STREAMCHIK — RENDERER
// ===============================

// --- DOM-элементы ---
const btnStartScreen = document.getElementById("startScreen");
const btnStopScreen  = document.getElementById("stopScreen");

const btnMicOn  = document.getElementById("micOn");
const btnMicOff = document.getElementById("micOff");

const localVideo  = document.getElementById("localScreen");
const remoteVideo = document.getElementById("remoteScreen");

const meDot     = document.getElementById("me-dot");
const friendDot = document.getElementById("friend-dot");

const fullscreenButtons = document.querySelectorAll(".fullscreen-btn");

// новое:
const selfListenCheckbox = document.getElementById("selfListen");
const micSelect          = document.getElementById("micSelect");
const outSelect          = document.getElementById("outSelect");
const selfMonitorAudio   = document.getElementById("selfMonitor");

// --- медиапотоки ---
let localScreenStream = null;
let localAudioStream  = null;

// выбранные устройства
let currentMicId  = "";
let currentOutId  = "";

// --- WebRTC / signaling ---
let pc = null;
let ws = null;

const SIGNALING_URL = "ws://91.219.61.150:8080";
const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };


// ===============================
//  ПОЛНОЭКРАННЫЙ РЕЖИМ
// ===============================
fullscreenButtons.forEach(btn => {
    btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        const video = document.getElementById(targetId);
        if (!video) return;

        if (!document.fullscreenElement) {
            video.requestFullscreen().catch(err => console.error("FS error:", err));
        } else {
            document.exitFullscreen().catch(err => console.error("Exit FS error:", err));
        }
    });
});


// ===============================
//  УСТРОЙСТВА ВВОДА/ВЫВОДА
// ===============================
async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        console.warn("enumerateDevices не поддерживается");
        return;
    }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        const inputs  = devices.filter(d => d.kind === "audioinput");
        const outputs = devices.filter(d => d.kind === "audiooutput");

        // МИКРОФОНЫ
        micSelect.innerHTML = "";
        const defIn = document.createElement("option");
        defIn.value = "";
        defIn.textContent = "Системный по умолчанию";
        micSelect.appendChild(defIn);

        inputs.forEach((d, idx) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Микрофон ${idx + 1}`;
            if (d.deviceId === currentMicId) opt.selected = true;
            micSelect.appendChild(opt);
        });

        // ВЫВОД
        outSelect.innerHTML = "";
        const defOut = document.createElement("option");
        defOut.value = "";
        defOut.textContent = "Системный по умолчанию";
        outSelect.appendChild(defOut);

        outputs.forEach((d, idx) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Устройство ${idx + 1}`;
            if (d.deviceId === currentOutId) opt.selected = true;
            outSelect.appendChild(opt);
        });

    } catch (err) {
        console.error("Ошибка enumerateDevices:", err);
    }
}

micSelect.addEventListener("change", () => {
    currentMicId = micSelect.value;
});

outSelect.addEventListener("change", () => {
    currentOutId = outSelect.value;
    applyOutputDevice();
});

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
}

refreshDevices();


// ===============================
//  Применить устройство вывода
// ===============================
async function applyOutputDevice() {
    if (!("setSinkId" in HTMLMediaElement.prototype)) {
        console.warn("setSinkId не поддерживается этим движком");
        return;
    }

    const targetElements = [selfMonitorAudio, remoteVideo];

    for (const el of targetElements) {
        if (!el) continue;
        try {
            if (currentOutId) {
                await el.setSinkId(currentOutId);
            } else {
                await el.setSinkId(""); // дефолт
            }
        } catch (err) {
            console.error("Ошибка setSinkId:", err);
        }
    }
}


// ===============================
//  WEBRTC + SIGNALING
// ===============================
function ensurePeerConnection() {
    if (pc) return;
    pc = new RTCPeerConnection(ICE_CONFIG);

    pc.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ice", candidate: e.candidate }));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log("Peer state:", pc.connectionState);
        if (pc.connectionState === "connected") {
            friendDot.style.background = "#00ff66"; // зелёный
        } else if (pc.connectionState === "connecting") {
            friendDot.style.background = "orange";
        } else {
            friendDot.style.background = "red";
        }
    };

    pc.ontrack = (event) => {
        console.log("Получен трек от друга");
        remoteVideo.srcObject = event.streams[0];
    };
}

function connectSignaling() {
    try {
        ws = new WebSocket(SIGNALING_URL);

        ws.onopen = () => {
            console.log("WS: соединение установлено");
            meDot.style.background = "#00ff66"; // зелёный — сервер доступен
        };

        ws.onerror = (e) => {
            console.warn("WS: ошибка", e);
            meDot.style.background = "orange";
        };

        ws.onclose = () => {
            console.warn("WS: соединение закрыто");
            meDot.style.background = "red";
            setTimeout(connectSignaling, 3000);
        };

        ws.onmessage = async (msg) => {
            const data = JSON.parse(msg.data);

            if (data.type === "offer") {
                await handleOffer(data.offer);
            } else if (data.type === "answer" && pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            } else if (data.type === "ice" && pc && data.candidate) {
                await pc.addIceCandidate(data.candidate);
            }
        };
    } catch (err) {
        console.error("Ошибка подключения WS:", err);
        meDot.style.background = "red";
    }
}

connectSignaling();


// ===============================
//  СТРИМ ЭКРАНА
// ===============================
btnStartScreen.addEventListener("click", startScreenShare);
btnStopScreen.addEventListener("click", stopScreenShare);

async function startScreenShare() {
    console.log("→ Запуск стрима экрана...");
    try {
        const sources = await window.electronAPI.getSources();
        console.log("Источники экрана:", sources);

        if (!sources || sources.length === 0) {
            throw new Error("Не найдено ни одного экрана");
        }

        const screenId = sources[0].id;

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: screenId
                }
            }
        });

        localScreenStream = stream;
        localVideo.srcObject = stream;

        ensurePeerConnection();

        localScreenStream.getTracks().forEach(track => {
            pc.addTrack(track, localScreenStream);
        });

        if (ws && ws.readyState === WebSocket.OPEN) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "offer", offer }));
        }

        btnStartScreen.disabled = true;
        btnStopScreen.disabled  = false;

        console.log("✔ Стрим экрана запущен");

    } catch (err) {
        console.error("Ошибка при запуске стрима:", err);

        if (!localScreenStream) {
            alert("Не удалось запустить стрим. Подробности — в консоли.");
        }
    }
}

function stopScreenShare() {
    console.log("→ Остановка стрима экрана...");
    if (localScreenStream) {
        localScreenStream.getTracks().forEach(t => t.stop());
        localScreenStream = null;
    }
    localVideo.srcObject = null;

    btnStartScreen.disabled = false;
    btnStopScreen.disabled  = true;

    console.log("✔ Стрим экрана остановлен");
}


// ===============================
//  ОБРАБОТКА OFFER
// ===============================
async function handleOffer(offer) {
    console.log("← Получен offer");
    ensurePeerConnection();

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "answer", answer }));
    }
}


// ===============================
//  МИКРОФОН + ПРОСЛУШКА
// ===============================
btnMicOn.addEventListener("click", enableMic);
btnMicOff.addEventListener("click", disableMic);
selfListenCheckbox.addEventListener("change", updateSelfMonitor);

async function enableMic() {
    try {
        const audioConstraint = currentMicId
            ? { deviceId: { exact: currentMicId } }
            : true;

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraint,
            video: false
        });

        localAudioStream = stream;

        if (pc) {
            localAudioStream.getTracks().forEach(track => {
                pc.addTrack(track, localAudioStream);
            });
        }

        btnMicOn.disabled  = true;
        btnMicOff.disabled = false;
        console.log("✔ Микрофон включён");

        updateSelfMonitor();

    } catch (err) {
        console.error("Ошибка включения микрофона:", err);
        alert("Не удалось включить микрофон");
    }
}

function disableMic() {
    if (localAudioStream) {
        localAudioStream.getTracks().forEach(t => t.stop());
        localAudioStream = null;
    }
    btnMicOn.disabled  = false;
    btnMicOff.disabled = true;
    console.log("✔ Микрофон выключен");

    updateSelfMonitor();
}

function updateSelfMonitor() {
    if (!selfListenCheckbox.checked || !localAudioStream) {
        selfMonitorAudio.srcObject = null;
        return;
    }

    selfMonitorAudio.srcObject = localAudioStream;
    selfMonitorAudio.muted = false;
    applyOutputDevice(); // чтобы учесть выбранное устройство вывода
}
