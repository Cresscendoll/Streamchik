const { contextBridge, ipcRenderer } = require("electron");

const SIGNALING_URL = process.env.SIGNALING_URL || "ws://localhost:8080";

contextBridge.exposeInMainWorld("electronAPI", {
    // управление окном
    minimize: () => ipcRenderer.send("window-minimize"),
    maximize: () => ipcRenderer.send("window-maximize"),
    close:    () => ipcRenderer.send("window-close"),

    // список доступных экранов (из main.js через desktopCapturer)
    getSources: () => ipcRenderer.invoke("get-sources"),
    checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
    signalingUrl: SIGNALING_URL
});
