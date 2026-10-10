const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
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
const { getSteamInstallPath, ensureProtonMappings, addAppShortcut } = require("./lib/steamShortcuts");
const saveSync = require("./lib/saveSync");
const { detectSaveFolder } = require("./lib/saveLocations");
const { findSteamAppId } = require("./lib/artwork");

let reloadTimer = null;
let relaunching = false;
let mainWindowRef = null;

// Launched by a Steam shortcut as `--nsu-wrap <shortcutId> -- <game command>`: sync, run game, sync, exit.
const isWrapMode = process.argv.includes("--nsu-wrap");
// Deck Game Mode (gamescope) only shows the game's own windows, so a dialog from the wrapper
// would sit invisible and leave Steam stuck on the loading screen. There we never block on one.
const isGameMode = process.env.XDG_CURRENT_DESKTOP === "gamescope" || Boolean(process.env.GAMESCOPE_WAYLAND_DISPLAY);
if (isWrapMode) app.disableHardwareAcceleration(); // wrapper only ever shows message boxes
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

  // Links (e.g. the SteamGridDB key page) open in the real browser, not a bare Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
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

// A synced game is unwrapped for the rename (its Steam id changes with the name), then re-wrapped
// under the new id. The cloud key follows the new name, so other devices should use the same name.
ipcMain.handle("app:renameGame", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    const id = String(Number(payload?.shortcutId) >>> 0);
    const sync = settings.syncGames[id];
    if (sync) await unwrapShortcut(id, sync.gameExe);

    let response;
    try {
      response = await renameGame(payload, { apiKey: settings.steamGridDbApiKey });
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
    if (!sync) return response;
    if (!response.ok) {
      await wrapShortcut(id, getWrapper()).catch(() => {});
      return response;
    }

    const newId = String(response.result.shortcutId);
    await wrapShortcut(newId, getWrapper());
    delete settings.syncGames[id];
    const name = response.result.appName;
    settings.syncGames[newId] = { ...sync, key: saveSync.gameKey(name), name, lastSync: null, localMtime: 0 };
    await writeAppSettings(settings);
    await publishDevice(settings).catch(() => {});
    return response;
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

// rclone ships inside the app (scripts/fetch-rclone.js) and keeps its own config in userData,
// so nothing needs to be installed and the user's own rclone setup (if any) is never touched.
function getRclone() {
  const bin = process.platform === "win32" ? "rclone.exe" : "rclone";
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "rclone")
    : path.join(__dirname, "vendor", "rclone", process.platform === "win32" ? "win32" : "linux");
  return { rclonePath: path.join(dir, bin), rcloneConfig: path.join(app.getPath("userData"), "rclone.conf") };
}

ipcMain.handle("app:getCloudSettings", async () => {
  const settings = await readAppSettings();
  return { ok: true, rcloneRemote: settings.rcloneRemote };
});

ipcMain.handle("app:saveCloudSettings", async (_, payload) => {
  try {
    const settings = await readAppSettings();
    settings.rcloneRemote = String(payload?.rcloneRemote || "").trim();
    await writeAppSettings(settings);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

// Creates an rclone remote named "nsu"; rclone opens the browser for the OAuth login.
ipcMain.handle("app:connectCloud", async (_, payload) => {
  try {
    const type = String(payload?.type || "");
    if (!["drive", "onedrive", "dropbox"].includes(type)) {
      throw new Error("Unsupported cloud provider.");
    }
    await saveSync.rcloneOk(getRclone(), ["config", "create", "nsu", type]);
    const settings = await readAppSettings();
    settings.rcloneRemote = "nsu:";
    await writeAppSettings(settings);
    return { ok: true, rcloneRemote: "nsu:" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:testCloud", async (_, payload) => {
  try {
    await saveSync.rcloneOk(getRclone(), ["lsd", saveSync.remoteJoin(payload?.rcloneRemote)]);
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
    ...getRclone(),
    remote: settings.rcloneRemote,
    deviceId: settings.deviceId,
    deviceName: getDeviceName(settings),
    backupsRoot: path.join(app.getPath("userData"), "save-backups"),
    // Wrapper: a dead network must fail fast rather than hold up the game launch.
    extraArgs: isWrapMode ? ["--contimeout", "15s", "--timeout", "30s", "--retries", "1", "--low-level-retries", "3"] : [],
    ask: async (message, buttons, defaultId = 0) =>
      isWrapMode && isGameMode
        ? (wrapLog(`auto-answered "${buttons[defaultId]}": ${message}`), defaultId)
        : (
        await dialog.showMessageBox({
          type: "question",
          title: "Non-Steam Uploader - Save Sync",
          message,
          buttons,
          defaultId,
          cancelId: buttons.length - 1,
          noLink: true
        })
      ).response
  };
}

function getDeviceName(settings) {
  return settings.deviceName || os.hostname();
}

// Publishes this device and the games it syncs to the cloud's linked-devices list.
async function publishDevice(settings) {
  if (!settings.rcloneRemote) return null;
  return saveSync.writeDevice(getSyncConfig(settings), {
    id: settings.deviceId,
    name: getDeviceName(settings),
    platform: process.platform,
    games: Object.values(settings.syncGames).map((g) => ({ key: g.key, name: g.name || g.key }))
  });
}

ipcMain.handle("app:getCloudOverview", async () => {
  try {
    const settings = await readAppSettings();
    if (!settings.rcloneRemote) {
      return { ok: true, connected: false, thisDeviceId: settings.deviceId, deviceName: getDeviceName(settings) };
    }
    await publishDevice(settings);
    const overview = await saveSync.listCloud(getSyncConfig(settings));
    return { ok: true, connected: true, thisDeviceId: settings.deviceId, deviceName: getDeviceName(settings), ...overview };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:renameDevice", async (_, name) => {
  try {
    const settings = await readAppSettings();
    settings.deviceName = String(name || "").trim();
    await writeAppSettings(settings);
    await publishDevice(settings);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

ipcMain.handle("app:forgetDevice", async (_, deviceId) => {
  try {
    const settings = await readAppSettings();
    await saveSync.forgetDevice(getSyncConfig(settings), String(deviceId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

// Adds this app itself to Steam so it can be opened from Game Mode on the Deck.
ipcMain.handle("app:addSelfToSteam", async () => {
  try {
    const wrapper = getWrapper();
    await addAppShortcut({ exe: wrapper.exe, args: wrapper.args, appName: "Non-Steam Uploader" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

// Looks the game up in the Ludusavi manifest. Null when unknown, or offline with no cached list.
async function detectSaveFolderFor(game, bases) {
  try {
    const steamId = await findSteamAppId(game.appName).catch(() => null);
    return await detectSaveFolder({ name: game.appName, steamId, bases, cacheDir: app.getPath("userData") });
  } catch {
    return null;
  }
}

// Suggests a save folder from the Ludusavi manifest and lets the user confirm or pick another.
// Returns a path token, or null when canceled.
async function chooseSaveFolder(game, bases) {
  const detected = await detectSaveFolderFor(game, bases);

  let defaultPath = process.platform === "win32" ? bases.AppData : fs.existsSync(bases.Home) ? bases.Home : undefined;
  if (detected) {
    const { best } = detected;
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "Save Sync",
      message: `Found where ${game.appName} keeps its saves:`,
      detail:
        `${best.absPath}\n\n` +
        (best.exists ? "" : "This folder doesn't exist yet. It will sync once the game creates it.\n\n") +
        `Source: PCGamingWiki via the Ludusavi manifest (${detected.manifestName}).`,
      buttons: ["Use this folder", "Choose another folder...", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (response === 0) return best.token;
    if (response === 2) return null;
    if (best.exists) defaultPath = best.absPath;
  }

  const picked = await dialog.showOpenDialog({
    title: `Select the save folder for ${game.appName}`,
    defaultPath,
    properties: ["openDirectory"]
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  return saveSync.tokenizePath(picked.filePaths[0], bases);
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
    // auto: no dialogs (used after adding a game and for batches). Unknown games are skipped, not asked about.
    const auto = Boolean(payload?.auto);
    const settings = await readAppSettings();
    if (!settings.rcloneRemote) {
      if (auto) return { ok: true, skipped: "Cloud saves aren't connected." };
      throw new Error("Connect a cloud account first (Cloud Saves, top right).");
    }

    const game = await findGame(payload?.shortcutId);
    if (!game) {
      throw new Error("Game not found in managed list.");
    }
    if (settings.syncGames[String(game.shortcutId)]) {
      return { ok: true, alreadyOn: true };
    }

    const key = saveSync.gameKey(game.appName);
    const bases = getSyncBases(game.shortcutId, game.startDir);
    const meta = await saveSync.readMeta(getSyncConfig(settings), key);

    let savePath = meta?.savePath;
    if (!savePath && auto) {
      savePath = (await detectSaveFolderFor(game, bases))?.best.token;
      if (!savePath) return { ok: true, skipped: "Save location unknown. Turn it on from the game's menu to pick the folder." };
    }
    savePath = savePath || (await chooseSaveFolder(game, bases));
    if (!savePath) {
      return { ok: true, canceled: true };
    }

    const { gameExe } = await wrapShortcut(game.shortcutId, getWrapper());
    settings.syncGames[String(game.shortcutId)] = {
      key,
      name: game.appName,
      savePath,
      gameExe: gameExe || settings.syncGames[String(game.shortcutId)]?.gameExe || game.exePath,
      gameDir: game.startDir,
      lastSync: null,
      localMtime: 0
    };
    await writeAppSettings(settings);
    await publishDevice(settings).catch(() => {});

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
    await publishDevice(settings).catch(() => {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
});

// <userData>/wrap.log: what the wrapper did on each launch (the only trace in Game Mode).
function wrapLog(line) {
  try {
    const file = path.join(app.getPath("userData"), "wrap.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}
`);
  } catch {}
}

function wrapError(message) {
  wrapLog(`ERROR ${message}`);
  if (!isGameMode) dialog.showErrorBox("Non-Steam Uploader", message);
}

async function runWrapMode() {
  wrapLog(`start ${JSON.stringify(process.argv.slice(1))} gameMode=${isGameMode}`);
  const flagIndex = process.argv.indexOf("--nsu-wrap");
  const shortcutId = String(Number(process.argv[flagIndex + 1]) >>> 0);
  const separator = process.argv.indexOf("--", flagIndex);
  const command = separator >= 0 ? process.argv.slice(separator + 1) : [];
  if (command.length === 0) {
    wrapError("No game command was given to --nsu-wrap.");
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
        wrapLog(`pre-launch sync: ${await saveSync.syncBeforeLaunch(cfg, state, localDir)}`);
        await writeAppSettings(settings);
      }
    } catch (error) {
      await cfg.ask(`Couldn't sync saves before launch:\n${error.message}\n\nThe game will start with the local save.`, ["OK"]);
    }
  }

  // Steam (e.g. "Exit game" in the Deck overlay) sends SIGTERM to the whole process group.
  // Ignore it so we outlive the game long enough to upload; if Steam follows up with SIGKILL,
  // the next launch uploads the leftover changes before starting (see syncBeforeLaunch).
  process.on("SIGTERM", () => {});

  wrapLog(`launching game`);
  const exitCode = await new Promise((resolve) => {
    // ponytail: waits for the launched process only; games whose launcher exits early get backed up too soon.
    const child = spawn(command[0], command.slice(1), {
      cwd: process.platform === "win32" ? state?.gameDir || path.dirname(command[0]) : undefined,
      stdio: "inherit"
    });
    child.on("error", (error) => {
      wrapError(`Could not start the game:\n${error.message}`);
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
      wrapLog(`game exited; post-game sync: ${await saveSync.syncAfterExit(getSyncConfig(fresh), freshState, localDir)}`);
      fresh.syncGames[shortcutId] = freshState;
      await writeAppSettings(fresh);
      await publishDevice(fresh).catch(() => {});
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
    rcloneRemote: "",
    syncGames: {},
    deviceId: "",
    deviceName: ""
  };

  let settings;
  try {
    const raw = await fs.promises.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    settings = {
      steamGridDbApiKey: String(parsed?.steamGridDbApiKey || "").trim(),
      hasSeenApiKeyPrompt: Boolean(parsed?.hasSeenApiKeyPrompt),
      steamInstallPath: String(parsed?.steamInstallPath || "").trim(),
      rcloneRemote: String(parsed?.rcloneRemote || "").trim(),
      syncGames: parsed?.syncGames && typeof parsed.syncGames === "object" ? parsed.syncGames : {},
      deviceId: String(parsed?.deviceId || "").trim(),
      deviceName: String(parsed?.deviceName || "").trim()
    };
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    settings = defaults;
  }

  // Stable identity for the linked-devices list; created once per install.
  if (!settings.deviceId) {
    settings.deviceId = crypto.randomUUID();
    await writeAppSettings(settings);
  }
  return settings;
}

async function writeAppSettings(settings) {
  const normalized = {
    steamGridDbApiKey: String(settings?.steamGridDbApiKey || "").trim(),
    hasSeenApiKeyPrompt: Boolean(settings?.hasSeenApiKeyPrompt),
    steamInstallPath: String(settings?.steamInstallPath || "").trim(),
    rcloneRemote: String(settings?.rcloneRemote || "").trim(),
    syncGames: settings?.syncGames && typeof settings.syncGames === "object" ? settings.syncGames : {},
    deviceId: String(settings?.deviceId || "").trim(),
    deviceName: String(settings?.deviceName || "").trim()
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
      wrapError(error instanceof Error ? error.stack || error.message : String(error));
      return 1;
    })
    .then((code) => {
      wrapLog(`exit ${code}`);
      app.exit(code);
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
