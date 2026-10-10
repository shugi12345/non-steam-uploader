// Cross-device save sync for non-Steam shortcuts, backed by an rclone remote.
//
// Cloud layout per game:  <remote>non-steam-saves/<key>/meta.json + files/...
// Save folders are stored as portable tokens ("{AppData}/Game/Saves") so the same entry
// resolves to %APPDATA% on Windows and to the shortcut's Proton prefix on the Steam Deck.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Most specific first: Home contains all the others.
const TOKEN_ORDER = ["GameDir", "LocalLow", "LocalAppData", "AppData", "Documents", "Home"];
const KEEP_LOCAL_BACKUPS = 5;

function gameKey(appName) {
  return String(appName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function protonUserDir(steamPath, shortcutId) {
  // ponytail: assumes compatdata lives in the main Steam library, which is where Steam puts it for shortcuts.
  return path.posix.join(steamPath, "steamapps", "compatdata", String(shortcutId), "pfx", "drive_c", "users", "steamuser");
}

function getBases({ platform = process.platform, gameDir, steamPath, shortcutId, documentsDir }) {
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return {
      GameDir: gameDir,
      LocalLow: path.join(path.dirname(local), "LocalLow"),
      LocalAppData: local,
      AppData: process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      Documents: documentsDir || path.join(os.homedir(), "Documents"),
      Home: os.homedir()
    };
  }

  const user = protonUserDir(steamPath, shortcutId);
  return {
    GameDir: gameDir,
    LocalLow: path.posix.join(user, "AppData", "LocalLow"),
    LocalAppData: path.posix.join(user, "AppData", "Local"),
    AppData: path.posix.join(user, "AppData", "Roaming"),
    Documents: path.posix.join(user, "Documents"),
    Home: user
  };
}

function tokenizePath(absPath, bases, pathImpl = path) {
  for (const name of TOKEN_ORDER) {
    const base = bases[name];
    if (!base) continue;
    const rel = pathImpl.relative(base, absPath);
    if (rel === "" || (!rel.startsWith("..") && !pathImpl.isAbsolute(rel))) {
      const tail = rel.split(pathImpl.sep).filter(Boolean).join("/");
      return tail ? `{${name}}/${tail}` : `{${name}}`;
    }
  }
  throw new Error("Save folder must be inside the game folder or your user profile (AppData, Documents, ...).");
}

function resolveToken(token, bases, pathImpl = path) {
  const match = /^\{(\w+)\}(?:\/(.*))?$/.exec(String(token || ""));
  if (!match || !bases[match[1]]) {
    throw new Error(`Invalid save path token: ${token}`);
  }
  const rest = match[2] ? match[2].split("/") : [];
  return pathImpl.join(bases[match[1]], ...rest);
}

function remoteJoin(remote, ...parts) {
  const base = String(remote || "").trim();
  if (!base) throw new Error("No cloud remote configured. Open Cloud Saves to set one up.");
  const rest = parts.join("/");
  return base.endsWith(":") || base.endsWith("/") ? base + rest : `${base}/${rest}`;
}

// rc = { rclonePath, rcloneConfig }: the bundled binary plus the app-private rclone.conf.
function runRclone(rc, args, input) {
  return new Promise((resolve, reject) => {
    const configArgs = rc.rcloneConfig ? ["--config", rc.rcloneConfig] : [];
    const child = spawn(rc.rclonePath || "rclone", [...configArgs, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) =>
      reject(new Error(error.code === "ENOENT" ? "Bundled rclone is missing. Reinstall the app." : error.message))
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function rcloneOk(rc, args, input) {
  const result = await runRclone(rc, args, input);
  if (result.code !== 0) {
    throw new Error(`rclone ${args[0]} failed: ${result.stderr.trim().split("\n").pop() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

async function readMeta(cfg, key) {
  const result = await runRclone(cfg, ["cat", remoteJoin(cfg.remote, "non-steam-saves", key, "meta.json")]);
  if (result.code !== 0) {
    if (/not found|doesn't exist|no such|directory not found/i.test(result.stderr)) return null;
    throw new Error(`Could not reach cloud: ${result.stderr.trim().split("\n").pop() || `exit ${result.code}`}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function newestMtime(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let newest = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(entry.parentPath || entry.path, entry.name));
    newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

async function backupLocal(localDir, backupsRoot, key) {
  if (!(await newestMtime(localDir))) return null;
  const dir = path.join(backupsRoot, key);
  const target = path.join(dir, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.cp(localDir, target, { recursive: true });
  const all = (await fs.readdir(dir)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_LOCAL_BACKUPS))) {
    await fs.rm(path.join(dir, old), { recursive: true, force: true });
  }
  return target;
}

function describeMeta(meta) {
  return `${meta.device || "another device"} at ${new Date(meta.updatedAt).toLocaleString()}`;
}

async function pullDown(cfg, state, localDir, meta) {
  await backupLocal(localDir, cfg.backupsRoot, state.key);
  await fs.mkdir(localDir, { recursive: true });
  await rcloneOk(cfg, ["sync", remoteJoin(cfg.remote, "non-steam-saves", state.key, "files"), localDir]);
  state.lastSync = meta.updatedAt;
  state.localMtime = await newestMtime(localDir);
  return "pulled";
}

// Before launch: bring the cloud save down if another device uploaded since our last sync.
// `cfg.ask(message, buttons)` resolves to the clicked button index.
async function syncBeforeLaunch(cfg, state, localDir) {
  const meta = await readMeta(cfg, state.key);
  if (!meta || meta.updatedAt === state.lastSync) return "up-to-date";

  const localNow = await newestMtime(localDir);
  const localChanged = localNow > 0 && (!state.lastSync || localNow > (state.localMtime || 0));
  if (localChanged) {
    const choice = await cfg.ask(
      `Save conflict for ${state.key}.\n\nCloud: saved by ${describeMeta(meta)}\nThis device: ${new Date(localNow).toLocaleString()}\n\nThe save you don't pick is kept as a local backup.`,
      ["Use cloud save", "Keep this device's save"]
    );
    if (choice === 1) {
      // Acknowledge the cloud version so the post-game upload replaces it.
      state.lastSync = meta.updatedAt;
      return "kept-local";
    }
  }
  return pullDown(cfg, state, localDir, meta);
}

// After exit: upload if the local save changed.
async function syncAfterExit(cfg, state, localDir) {
  const localNow = await newestMtime(localDir);
  if (!localNow) return "no-local-save";
  if (state.lastSync && localNow <= (state.localMtime || 0)) return "unchanged";

  const meta = await readMeta(cfg, state.key);
  if (meta && meta.updatedAt !== state.lastSync) {
    const choice = await cfg.ask(
      `The cloud has a newer save for ${state.key}, from ${describeMeta(meta)}.\n\nUpload this device's save over it, or replace this device's save with the cloud one? (This device's save is backed up locally first.)`,
      ["Upload mine", "Use cloud save"]
    );
    if (choice === 1) return pullDown(cfg, state, localDir, meta);
  }

  await rcloneOk(cfg, ["sync", localDir, remoteJoin(cfg.remote, "non-steam-saves", state.key, "files")]);
  const nextMeta = { updatedAt: new Date().toISOString(), device: os.hostname(), savePath: state.savePath };
  await rcloneOk(
    cfg,
    ["rcat", remoteJoin(cfg.remote, "non-steam-saves", state.key, "meta.json")],
    JSON.stringify(nextMeta, null, 2)
  );
  state.lastSync = nextMeta.updatedAt;
  state.localMtime = localNow;
  return "pushed";
}

module.exports = {
  gameKey,
  protonUserDir,
  getBases,
  tokenizePath,
  resolveToken,
  readMeta,
  runRclone,
  rcloneOk,
  remoteJoin,
  syncBeforeLaunch,
  syncAfterExit
};

if (require.main === module) {
  const assert = require("assert");
  const win = getBases({
    platform: "win32",
    gameDir: "C:\\Games\\Foo"
  });
  const deck = getBases({
    platform: "linux",
    gameDir: "/home/deck/Games/Foo",
    steamPath: "/home/deck/.local/share/Steam",
    shortcutId: 3000000001
  });

  if (process.platform === "win32") {
    const token = tokenizePath(path.join(win.AppData, "Foo", "Saves"), win);
    assert.strictEqual(token, "{AppData}/Foo/Saves");
    assert.strictEqual(tokenizePath(path.join(win.LocalLow, "Dev", "Foo"), win), "{LocalLow}/Dev/Foo");
    assert.strictEqual(tokenizePath("C:\\Games\\Foo\\save", win), "{GameDir}/save");
    assert.throws(() => tokenizePath("D:\\elsewhere", win));
    assert.strictEqual(
      resolveToken(token, deck, path.posix),
      "/home/deck/.local/share/Steam/steamapps/compatdata/3000000001/pfx/drive_c/users/steamuser/AppData/Roaming/Foo/Saves"
    );
  }
  assert.strictEqual(
    tokenizePath("/home/deck/Games/Foo/saves/slot1", deck, path.posix),
    "{GameDir}/saves/slot1"
  );
  assert.strictEqual(gameKey("Hollow Knight: Silksong"), "hollow-knight-silksong");
  assert.strictEqual(remoteJoin("nsu:", "non-steam-saves", "x"), "nsu:non-steam-saves/x");
  console.log("saveSync ok");
}
