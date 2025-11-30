const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let signalingUrl = process.env.SIGNALING_URL || "ws://185.181.165.175:8080";
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
    close: () => ipcRenderer.send("window-close"),

    // доступ к desktopCapturer и автообновлению
    getSources: () => ipcRenderer.invoke("get-sources"),
    checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
    signalingUrl,
    roomName,
    onUpdateProgress: (callback) => ipcRenderer.on('update-download-progress', (_event, value) => callback(value)),
    onUpdateError: (callback) => ipcRenderer.on('update-error', (_event, value) => callback(value))
});

contextBridge.exposeInMainWorld("paths", {
    logo: (() => {
        const candidates = [
            path.join(process.resourcesPath, "build", "name.png"),
            path.join(process.resourcesPath, "app.asar.unpacked", "build", "name.png"),
            path.join(__dirname, "build", "name.png")
        ];
        const existing = candidates.find(p => fs.existsSync(p));
        return pathToFileURL(existing || candidates[0]).toString();
    })()
});
