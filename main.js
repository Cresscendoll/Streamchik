const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const path = require("path");

let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 720,
        frame: false,
        titleBarStyle: "hidden",
        backgroundColor: "#111",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile("index.html");
}

// --- IPC -----------------------
ipcMain.on("window-minimize", () => win?.minimize());
ipcMain.on("window-maximize", () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window-close", () => win?.close());

ipcMain.handle("get-sources", async () => {
    return await desktopCapturer.getSources({ types: ["screen"] });
});

// --- APP -----------------------
app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});


