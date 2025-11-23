const { contextBridge, ipcRenderer } = require("electron");

let signalingUrl = process.env.SIGNALING_URL || "ws://91.219.61.150:8080";
let roomName = process.env.SIGNALING_ROOM || "room-1";

try {
    const cfg = require("./config");
    if (cfg?.signalingUrl) signalingUrl = cfg.signalingUrl;
    if (cfg?.roomName) roomName = cfg.roomName;
} catch (err) {
    console.error("[preload] Failed to load config.js, using defaults:", err?.message);
}

contextBridge.exposeInMainWorld("electronAPI", {
    // управляющие кнопки окна
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close:    () => ipcRenderer.send("window-close"),

    // доступ к desktopCapturer и автообновлению
    getSources: () => ipcRenderer.invoke("get-sources"),
    checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
    signalingUrl,
    roomName
});
