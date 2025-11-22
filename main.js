const { app, BrowserWindow, ipcMain, desktopCapturer, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
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

// ---------- IPC ----------
ipcMain.on("window-minimize", () => win?.minimize());
ipcMain.on("window-maximize", () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window-close", () => win?.close());

ipcMain.handle("get-sources", async () => {
    return await desktopCapturer.getSources({ types: ["screen"] });
});

// ---------- AUTOUPDATE ----------
function setupAutoUpdater() {
    autoUpdater.autoDownload = false;

    autoUpdater.on("checking-for-update", () => {
        console.log("🔍 Проверяю обновления...");
    });

    autoUpdater.on("update-available", async (info) => {
        console.log("⚡ Доступно новое обновление! Версия:", info?.version);

        const releaseNotes = Array.isArray(info?.releaseNotes)
            ? info.releaseNotes.map((note) => typeof note === "string" ? note : note?.note).join("\n\n")
            : typeof info?.releaseNotes === "string"
                ? info.releaseNotes
                : "";

        const detailParts = [
            `Доступна версия ${info?.version ?? ""}.`,
            releaseNotes ? `Что нового:\n${releaseNotes}` : ""
        ].filter(Boolean);

        const { response } = await dialog.showMessageBox(win, {
            type: "info",
            buttons: ["Обновить сейчас", "Позже"],
            defaultId: 0,
            cancelId: 1,
            title: "Доступно обновление",
            message: `Найдена новая версия ${info?.version ?? ""}`,
            detail: detailParts.join("\n\n")
        });

        if (response === 0) {
            autoUpdater.downloadUpdate();
        }
    });

    autoUpdater.on("update-not-available", () => {
        console.log("✔ Обновлений нет.");
    });

    autoUpdater.on("error", (err) => {
        console.log("❌ Ошибка автообновления:", err);
    });

    autoUpdater.on("download-progress", (p) => {
        console.log(`📥 Загрузка: ${Math.floor(p.percent)}%`);
    });

    autoUpdater.on("update-downloaded", async (info) => {
        console.log("📦 Обновление скачано. Будет установлено при перезапуске.");

        const { response } = await dialog.showMessageBox(win, {
            type: "question",
            buttons: ["Перезапустить сейчас", "Позже"],
            defaultId: 0,
            cancelId: 1,
            title: "Обновление скачано",
            message: `Установить версию ${info?.version ?? "новую версию"} сейчас?`
        });

        if (response === 0) {
            autoUpdater.quitAndInstall();
        }
    });

    autoUpdater.checkForUpdatesAndNotify();
}

// ---------- APP ----------
app.whenReady().then(() => {
    createWindow();
    setupAutoUpdater();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
