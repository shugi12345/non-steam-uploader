const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  processInput,
  getGames,
  removeGame,
  renameGame,
  setGameVr,
  removeAllGames,
  findGame,
  getArtOptions,
  setGameArt,
  wrapShortcut,
  unwrapShortcut
} = require("./lib/processor");
const { getSteamInstallPath, ensureProtonMappings } = require("./lib/steamShortcuts");
const saveSync = require("./lib/saveSync");

let reloadTimer = null;
let relaunching = false;
let mainWindowRef = null;

// Launched by a Steam shortcut as `--nsu-wrap <shortcutId> -- <game command>`: sync, run game, sync, exit.
const isWrapMode = process.argv.includes("--nsu-wrap");
const hasSingleInstanceLock = isWrapMode ? false : app.requestSingleInstanceLock();
if (!isWrapMode && !hasSingleInstanceLock) {
  app.quit();
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    title: "Non-Steam Uploader",
    backgroundColor: "#0f172a",
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
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
  mainWindowRef = mainWindow;

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null;
    }
  });
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

ipcMain.handle("app:getSteamInstallLocation", async () => {
  try {
    const settings = await readAppSettings();
    return {
      ok: true,
      steamInstallPath: settings.steamInstallPath || process.env.STEAM_PATH || ""
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
});

ipcMain.handle("app:pickSteamInstallLocation", async () => {
  try {
    const settings = await readAppSettings();
    const result = await dialog.showOpenDialog({
      title: "Select Steam install location",
      defaultPath: settings.steamInstallPath || process.env.STEAM_PATH || undefined,
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, canceled: true };
    }

    const selectedPath = path.resolve(result.filePaths[0]);
    const marker = process.platform === "win32" ? "steam.exe" : "userdata";
    if (!fs.existsSync(path.join(selectedPath, marker))) {
      return {
        ok: false,
        error: `Selected folder is not a Steam install location (${marker} not found).`
      };
    }

    settings.steamInstallPath = selectedPath;
    await writeAppSettings(settings);
    applySteamInstallPath(settings.steamInstallPath);

    return { ok: true, canceled: false, steamInstallPath: selectedPath };
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
    if (process.platform === "linux") {
      const protonMappings = await restartSteamLinux();
      return { ok: true, protonMappings };
    }

    const steamExe = getSteamExePath();
    restartSteamInBackground(steamExe);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to restart Steam."
    };
  }
});

// Steam rewrites config.vdf when it exits, so Proton mappings are written between stop and start.
async function restartSteamLinux() {
  spawn("pkill", ["-TERM", "-x", "steam"], { stdio: "ignore" });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const running = await new Promise((resolve) => {
      const check = spawn("pgrep", ["-x", "steam"], { stdio: "ignore" });
      check.on("exit", (code) => resolve(code === 0));
      check.on("error", () => resolve(false));
    });
    if (!running) break;
  }

  const added = await ensureProtonMappings();
  spawn("steam", [], { detached: true, stdio: "ignore" }).unref();
  return added;
}

ipcMain.handle("app:listArtOptions", async (_, shortcutId) => {
  try {
    const settings = await readAppSettings();
    return await getArtOptions(shortcutId, { apiKey: settings.steamGridDbApiKey });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:setArt", async (_, payload) => {
  try {
    return await setGameArt(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:pickArtFile", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select artwork image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle("app:getCloudSettings", async () => {
  const settings = await readAppSettings();
  return { ok: true, rclonePath: settings.rclonePath, rcloneRemote: settings.rcloneRemote };
});

ipcMain.handle("app:saveCloudSettings", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    settings.rclonePath = String(payload?.rclonePath || "").trim();
    settings.rcloneRemote = String(payload?.rcloneRemote || "").trim();
    await writeAppSettings(settings);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:pickRclone", async () => {
  const result = await dialog.showOpenDialog({ title: "Select rclone executable", properties: ["openFile"] });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// Creates an rclone remote named "nsu"; rclone opens the browser for the OAuth login.
ipcMain.handle("app:connectCloud", async (_, payload) => {
  try {
    const type = String(payload?.type || "");
    if (!["drive", "onedrive", "dropbox"].includes(type)) {
      throw new Error("Unsupported cloud provider.");
    }
    const rclonePath = String(payload?.rclonePath || "").trim();
    await saveSync.rcloneOk(rclonePath, ["config", "create", "nsu", type]);
    return { ok: true, rcloneRemote: "nsu:" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:testCloud", async (_, payload) => {
  try {
    await saveSync.rcloneOk(String(payload?.rclonePath || "").trim(), ["lsd", saveSync.remoteJoin(payload?.rcloneRemote)]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

function getWrapper() {
  if (process.env.APPIMAGE) return { exe: process.env.APPIMAGE, args: [] };
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [app.getAppPath()] };
}

function getSyncConfig(settings) {
  return {
    rclonePath: settings.rclonePath,
    remote: settings.rcloneRemote,
    backupsRoot: path.join(app.getPath("userData"), "save-backups"),
    ask: async (message, buttons) =>
      (
        await dialog.showMessageBox({
          type: "question",
          title: "Non-Steam Uploader - Save Sync",
          message,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
          noLink: true
        })
      ).response
  };
}

function getSyncBases(shortcutId, gameDir) {
  return saveSync.getBases({
    gameDir,
    steamPath: process.platform === "win32" ? null : getSteamInstallPath(),
    shortcutId,
    documentsDir: app.getPath("documents")
  });
}

ipcMain.handle("app:enableSync", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    if (!settings.rcloneRemote) {
      throw new Error("Set up Cloud Saves first (bottom bar).");
    }

    const game = await findGame(payload?.shortcutId);
    if (!game) {
      throw new Error("Game not found in managed list.");
    }

    const key = saveSync.gameKey(game.appName);
    const bases = getSyncBases(game.shortcutId, game.startDir);
    const meta = await saveSync.readMeta(getSyncConfig(settings), key);

    let savePath = meta?.savePath || "";
    if (!savePath) {
      const defaultPath = process.platform === "win32" ? bases.AppData : fs.existsSync(bases.Home) ? bases.Home : undefined;
      const picked = await dialog.showOpenDialog({
        title: `Select the save folder for ${game.appName}`,
        defaultPath,
        properties: ["openDirectory"]
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: true, canceled: true };
      }
      savePath = saveSync.tokenizePath(picked.filePaths[0], bases);
    }

    const { gameExe } = await wrapShortcut(game.shortcutId, getWrapper());
    settings.syncGames[String(game.shortcutId)] = {
      key,
      savePath,
      gameExe: gameExe || settings.syncGames[String(game.shortcutId)]?.gameExe || game.exePath,
      gameDir: game.startDir,
      lastSync: null,
      localMtime: 0
    };
    await writeAppSettings(settings);

    return {
      ok: true,
      key,
      savePath,
      resolvedPath: saveSync.resolveToken(savePath, bases),
      fromCloud: Boolean(meta),
      cloudDevice: meta?.device || null
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:disableSync", async (_, shortcutId) => {
  try {
    const settings = await readAppSettings();
    const id = String(Number(shortcutId) >>> 0);
    await unwrapShortcut(id, settings.syncGames[id]?.gameExe);
    delete settings.syncGames[id];
    await writeAppSettings(settings);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

async function runWrapMode() {
  const flagIndex = process.argv.indexOf("--nsu-wrap");
  const shortcutId = String(Number(process.argv[flagIndex + 1]) >>> 0);
  const separator = process.argv.indexOf("--", flagIndex);
  const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
  if (command.length === 0) {
    dialog.showErrorBox("Non-Steam Uploader", "No game command was given to --nsu-wrap.");
    return 1;
  }

  const settings = await readAppSettings();
  applySteamInstallPath(settings.steamInstallPath);
  const state = settings.syncGames[shortcutId];
  const cfg = getSyncConfig(settings);
  let localDir = null;

  if (state) {
    try {
      const bases = getSyncBases(shortcutId, state.gameDir);
      localDir = saveSync.resolveToken(state.savePath, bases);
      // First Deck launch: Proton hasn't created the prefix yet. Skip the pull; the post-game
      // step sees the cloud save and offers to replace whatever the fresh game wrote.
      if (process.platform === "win32" || fs.existsSync(bases.Home)) {
        await saveSync.syncBeforeLaunch(cfg, state, localDir);
        await writeAppSettings(settings);
      }
    } catch (error) {
      await cfg.ask(`Couldn't sync saves before launch:\n${error.message}\n\nThe game will start with the local save.`, ["OK"]);
    }
  }

  const exitCode = await new Promise((resolve) => {
    // ponytail: waits for the launched process only; games whose launcher exits early get backed up too soon.
    const child = spawn(command[0], command.slice(1), {
      cwd: process.platform === "win32" ? state?.gameDir || path.dirname(command[0]) : undefined,
      stdio: "inherit"
    });
    child.on("error", (error) => {
      dialog.showErrorBox("Non-Steam Uploader", `Could not start the game:\n${error.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });

  if (state && localDir) {
    try {
      // Re-read: the user may have changed settings while the game ran.
      const fresh = await readAppSettings();
      const freshState = fresh.syncGames[shortcutId] || state;
      Object.assign(freshState, { lastSync: state.lastSync, localMtime: state.localMtime });
      await saveSync.syncAfterExit(getSyncConfig(fresh), freshState, localDir);
      fresh.syncGames[shortcutId] = freshState;
      await writeAppSettings(fresh);
    } catch (error) {
      await cfg.ask(`Couldn't upload saves after playing:\n${error.message}\n\nThey will upload after your next session.`, ["OK"]);
    }
  }

  return exitCode;
}

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

function applySteamInstallPath(nextPath) {
  const value = String(nextPath || "").trim();
  if (!value) {
    delete process.env.STEAM_PATH;
    return;
  }
  process.env.STEAM_PATH = value;
}

function restartSteamInBackground(steamExe) {
  const escapedSteamExe = steamExe.replace(/"/g, '""');
  const launchViaCmd = () => {
    const launcher = spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${escapedSteamExe}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    launcher.unref();
  };

  const launchSteam = () => {
    setTimeout(() => {
      const steam = spawn(steamExe, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });

      steam.once("error", () => {
        launchViaCmd();
      });
      steam.unref();
    }, 900);
  };

  const killer = spawn("taskkill", ["/IM", "steam.exe", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });

  killer.on("error", launchSteam);
  killer.on("exit", launchSteam);
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function readAppSettings() {
  const defaults = {
    steamGridDbApiKey: "",
    hasSeenApiKeyPrompt: false,
    steamInstallPath: "",
    rclonePath: "",
    rcloneRemote: "",
    syncGames: {}
  };

  try {
    const raw = await fs.promises.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      steamGridDbApiKey: String(parsed?.steamGridDbApiKey || "").trim(),
      hasSeenApiKeyPrompt: Boolean(parsed?.hasSeenApiKeyPrompt),
      steamInstallPath: String(parsed?.steamInstallPath || "").trim(),
      rclonePath: String(parsed?.rclonePath || "").trim(),
      rcloneRemote: String(parsed?.rcloneRemote || "").trim(),
      syncGames: parsed?.syncGames && typeof parsed.syncGames === "object" ? parsed.syncGames : {}
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
    hasSeenApiKeyPrompt: Boolean(settings?.hasSeenApiKeyPrompt),
    steamInstallPath: String(settings?.steamInstallPath || "").trim(),
    rclonePath: String(settings?.rclonePath || "").trim(),
    rcloneRemote: String(settings?.rcloneRemote || "").trim(),
    syncGames: settings?.syncGames && typeof settings.syncGames === "object" ? settings.syncGames : {}
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

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) {
        mainWindowRef.restore();
      }
      mainWindowRef.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const settings = await readAppSettings();
      applySteamInstallPath(settings.steamInstallPath);
    } catch {
      // Keep defaults if settings cannot be loaded yet.
    }
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

if (isWrapMode) {
  app
    .whenReady()
    .then(runWrapMode)
    .catch((error) => {
      dialog.showErrorBox("Non-Steam Uploader", error instanceof Error ? error.message : String(error));
      return 1;
    })
    .then((code) => app.exit(code));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
