const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { processInput, getGames, removeGame, renameGame, setGameVr, removeAllGames } = require("./lib/processor");

let reloadTimer = null;
let relaunching = false;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    title: "Non-Steam Uploader",
    backgroundColor: "#0f172a",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));
  setupDevAutoReload(mainWindow);
}

ipcMain.handle("app:process", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    return await processInput(payload, {
      apiKey: settings.steamGridDbApiKey
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:listGames", async () => {
  try {
    return await getGames();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:removeGame", async (_, shortcutId) => {
  try {
    return await removeGame(shortcutId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:removeAll", async () => {
  try {
    return await removeAllGames();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:renameGame", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    return await renameGame(payload, {
      apiKey: settings.steamGridDbApiKey
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:getApiSettings", async () => {
  try {
    const settings = await readAppSettings();
    return {
      ok: true,
      apiKey: settings.steamGridDbApiKey || "",
      hasApiKey: Boolean(settings.steamGridDbApiKey),
      hasSeenPrompt: Boolean(settings.hasSeenApiKeyPrompt)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:saveApiKey", async (_, payload) => {
  try {
    const nextApiKey = String(payload?.apiKey || "").trim();
    const settings = await readAppSettings();
    settings.steamGridDbApiKey = nextApiKey;
    settings.hasSeenApiKeyPrompt = true;
    await writeAppSettings(settings);
    return { ok: true, hasApiKey: Boolean(nextApiKey) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:dismissApiKeyPrompt", async () => {
  try {
    const settings = await readAppSettings();
    settings.hasSeenApiKeyPrompt = true;
    await writeAppSettings(settings);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:setGameVr", async (_, payload) => {
  try {
    return await setGameVr(payload);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:pickExes", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select game files",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Game files", extensions: ["exe", "lnk"] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, paths: [] };
  }

  return { canceled: false, paths: result.filePaths };
});

ipcMain.handle("app:restartSteam", async () => {
  try {
    const steamExe = getSteamExePath();

    await execFileAsync("taskkill", ["/IM", "steam.exe", "/F"]);
    await delay(600);

    execFile(steamExe, [], {
      detached: true,
      stdio: "ignore"
    }).unref();

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to restart Steam."
    };
  }
});

function getSteamExePath() {
  const candidates = [
    process.env.STEAM_PATH,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Steam") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Steam") : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    const exePath = path.join(candidate, "steam.exe");
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  throw new Error("Steam executable not found. Set STEAM_PATH.");
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        // taskkill returns an error when Steam is not running; treat as success.
        if (file.toLowerCase() === "taskkill") {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readAppSettings() {
  const defaults = {
    steamGridDbApiKey: "",
    hasSeenApiKeyPrompt: false
  };

  try {
    const raw = await fs.promises.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      steamGridDbApiKey: String(parsed?.steamGridDbApiKey || "").trim(),
      hasSeenApiKeyPrompt: Boolean(parsed?.hasSeenApiKeyPrompt)
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return defaults;
    }
    throw error;
  }
}

async function writeAppSettings(settings) {
  const normalized = {
    steamGridDbApiKey: String(settings?.steamGridDbApiKey || "").trim(),
    hasSeenApiKeyPrompt: Boolean(settings?.hasSeenApiKeyPrompt)
  };

  await fs.promises.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.promises.writeFile(getSettingsPath(), JSON.stringify(normalized, null, 2), "utf8");
}

function setupDevAutoReload(mainWindow) {
  if (app.isPackaged) {
    return;
  }

  const watchTargets = [path.join(__dirname, "src"), path.join(__dirname, "lib"), path.join(__dirname, "preload.js"), path.join(__dirname, "main.js")];

  for (const target of watchTargets) {
    try {
      fs.watch(target, { recursive: true }, (_, filename) => {
        const changed = String(filename || "").toLowerCase();
        if (!changed) {
          return;
        }

        if (changed.includes("main.js")) {
          scheduleAppRelaunch();
          return;
        }

        scheduleRendererReload(mainWindow);
      });
    } catch {
      // Ignore watch errors in unsupported environments.
    }
  }
}

function scheduleRendererReload(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.reloadIgnoringCache();
    }
  }, 250);
}

function scheduleAppRelaunch() {
  if (relaunching) {
    return;
  }

  relaunching = true;
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 250);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
