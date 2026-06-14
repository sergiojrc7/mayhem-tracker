import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import path from "path";
import { initDatabase, getSetting, recomputeAllScores, setTierResolver } from "./db";
import { registerIpcHandlers } from "./ipc-handlers";
import { startPolling, stopPolling, getStatus, fetchNewGames } from "./lcu";
import { loadChampionData, loadAugmentData, waitForChampionData } from "./dragon";
import { loadTierData, waitForTierData, getTierMultiplier } from "./tiers";
import { BUILD_TAG } from "../build";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let didFinalFetch = false;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const iconPath = path.join(app.getAppPath(), "assets/icon.png");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    frame: false,
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0f",
      symbolColor: "#c89b3c",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // Close behavior: minimize to tray (default) or quit
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      const minimizeToTray = getSetting("minimize_to_tray");
      if (minimizeToTray !== "false") {
        event.preventDefault();
        mainWindow?.hide();
      } else {
        isQuitting = true;
        app.quit();
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Register IPC handlers
  registerIpcHandlers(mainWindow);

  // Start LCU polling
  startPolling(mainWindow);
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Mayhem Tracker");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

app.whenReady().then(async () => {
  console.log(`Mayhem Tracker build: ${BUILD_TAG} (v${app.getVersion()})`);

  // Initialize database first
  initDatabase();

  // Tier Multiplier (Fase 1.3): registra o resolver (retorna 1.0 até carregar) e
  // dispara o load (cache 24h em champion_tiers + fetch do endpoint da Blitz).
  setTierResolver(getTierMultiplier);
  loadTierData();

  // Load assets in background
  loadChampionData();
  loadAugmentData();

  createWindow();
  createTray();

  // Os scores dependem das tags de campeão (Role Weight, Fase 1.2) e dos tiers
  // (Fase 1.3), ambos assíncronos. Quando os dois ficarem prontos, recalcula e
  // atualiza a UI para que papel + tier sejam aplicados às partidas armazenadas.
  Promise.all([waitForChampionData(), waitForTierData()]).then(() => {
    try {
      recomputeAllScores();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("lcu:games-updated");
      }
    } catch (err) {
      console.log("Score recompute after champion/tier load failed:", err);
    }
  });
});

app.on("before-quit", async (event) => {
  isQuitting = true;

  if (!didFinalFetch && getStatus() === "connected") {
    event.preventDefault();
    didFinalFetch = true;
    try {
      console.log("Fetching games before quit...");
      await fetchNewGames(mainWindow);
    } catch (err) {
      console.log("Final fetch on quit failed:", err);
    }
    stopPolling();
    app.quit();
  } else {
    stopPolling();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Don't quit — we have the tray
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
