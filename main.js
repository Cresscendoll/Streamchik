const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const { signalingUrl, roomName, startLocalSignaling, signalingPort } = require("./config");
const { startSignalingServer } = require("./signaling-server");

const SIGNALING_URL = signalingUrl;
const ROOM_NAME = roomName;
const SHOULD_START_LOCAL_SIGNALING = startLocalSignaling && (SIGNALING_URL.includes("localhost") || SIGNALING_URL.includes("127.0.0.1"));
process.env.SIGNALING_URL = SIGNALING_URL;
process.env.SIGNALING_ROOM = ROOM_NAME;

let win;
let localServerStarted = false;

function createWindow() {
    const { height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
    const initialHeight = Math.min(900, workAreaHeight);

    win = new BrowserWindow({
        width: 1280,
        height: initialHeight,
        frame: false,
        titleBarStyle: "hidden",
        title: "CreamLine v1.0.9",
        icon: "build/icon.ico",
        backgroundColor: "#111",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    win.loadFile("index.html");
}

function ensureLocalSignalingServer() {
    if (!SHOULD_START_LOCAL_SIGNALING || localServerStarted) return;
    try {
        startSignalingServer({ port: signalingPort });
        localServerStarted = true;
        console.log(`Local signaling server started at ${SIGNALING_URL}`);
    } catch (err) {
        console.error("Failed to start local signaling server", err);
    }
}

// ---------- IPC ----------
ipcMain.on("window-minimize", () => win?.minimize());
ipcMain.on("window-maximize", () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on("window-close", () => win?.close());

ipcMain.handle("get-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        fetchWindowIcons: true,
        thumbnailSize: { width: 320, height: 180 }
    });

    return sources.map((source) => ({
        id: source.id,
        name: source.name,
        display_id: source.display_id,
        thumbnail: source.thumbnail?.toDataURL()
    }));
});

// ---------- AUTOUPDATE ----------
function setupAutoUpdater() {
    if (!app.isPackaged) {
        ipcMain.handle("check-for-updates", async () => {
            await dialog.showMessageBox(win, {
                type: "info",
                buttons: ["OK"],
                title: "Проверка обновлений",
                message: "Обновления доступны только в собранной версии приложения."
            });
            return { ok: false, reason: "dev" };
        });
        return;
    }

    autoUpdater.autoDownload = false;
    let manualUpdateCheck = false;

    autoUpdater.on("checking-for-update", () => {
        console.log("Проверяем обновления...");
    });

    autoUpdater.on("update-available", async (info) => {
        console.log("Доступно обновление:", info?.version);

        const releaseNotes = Array.isArray(info?.releaseNotes)
            ? info.releaseNotes
                .map((note) => typeof note === "string" ? note : note?.note)
                .join("\n\n")
            : typeof info?.releaseNotes === "string"
                ? info.releaseNotes
                : "";

        const detailParts = [
            info?.version ? `Найдена версия ${info.version}.` : "",
            releaseNotes ? `Изменения:\n${releaseNotes}` : ""
        ].filter(part => part);

        const { response } = await dialog.showMessageBox(win, {
            type: "info",
            buttons: ["Скачать и установить", "Позже"],
            defaultId: 0,
            cancelId: 1,
            title: "Доступно обновление",
            message: info?.version ? `Найдена версия ${info.version}` : "Доступно обновление",
            detail: detailParts.join("\n\n")
        });

        manualUpdateCheck = false;
        if (response === 0) {
            autoUpdater.downloadUpdate();
        }
    });

    autoUpdater.on("update-not-available", () => {
        console.log("Обновлений нет");
        if (manualUpdateCheck) {
            dialog.showMessageBox(win, {
                type: "info",
                buttons: ["Ок"],
                title: "Обновления",
                message: "Установлена последняя версия"
            });
        }
        manualUpdateCheck = false;
    });

    autoUpdater.on("error", (err) => {
        console.log("Ошибка автообновления:", err);
        if (win) win.webContents.send("update-error", err?.message || "Unknown error");
        if (manualUpdateCheck) {
            dialog.showMessageBox(win, {
                type: "error",
                buttons: ["Закрыть"],
                title: "Ошибка обновления",
                message: "Не удалось проверить обновления",
                detail: err?.message ?? ""
            });
        }
        manualUpdateCheck = false;
    });

    autoUpdater.on("download-progress", (p) => {
        const percent = Math.floor(p.percent);
        console.log(`Скачиваем обновление: ${percent}%`);
        if (win) win.webContents.send("update-download-progress", percent);
    });

    autoUpdater.on("update-downloaded", async (info) => {
        console.log("Обновление скачано", info?.version);

        const { response } = await dialog.showMessageBox(win, {
            type: "question",
            buttons: ["Перезапустить и установить", "Позже"],
            defaultId: 0,
            cancelId: 1,
            title: "Обновление скачано",
            message: info?.version ? `Установить версию ${info.version} сейчас?` : "Установить обновление сейчас?"
        });

        if (response === 0) {
            autoUpdater.quitAndInstall();
        }
    });

    ipcMain.handle("check-for-updates", async () => {
        manualUpdateCheck = true;
        try {
            await autoUpdater.checkForUpdates();
            return { ok: true };
        } catch (err) {
            manualUpdateCheck = false;
            dialog.showMessageBox(win, {
                type: "error",
                buttons: ["Закрыть"],
                title: "Ошибка обновления",
                message: "Не удалось проверить обновления",
                detail: err?.message ?? ""
            });
            throw err;
        }
    });

    autoUpdater.checkForUpdatesAndNotify();
}

// ---------- APP ----------
app.whenReady().then(() => {
    ensureLocalSignalingServer();
    createWindow();
    setupAutoUpdater();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
