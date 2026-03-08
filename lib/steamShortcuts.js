const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT = 0x02;
const TYPE_END = 0x08;
const MANAGED_TAG = "Added by Non-Steam Uploader";
const LEGACY_MANAGED_TAG = "Added by Steam Drop";

async function addShortcutForInput(input) {
  const context = await getSteamContext();
  const { shortcutsPath, gridDir } = context;

  await fs.mkdir(gridDir, { recursive: true });

  const launchConfig = await buildLaunchConfig(input);
  const appid = computeShortcutAppId(launchConfig.exe, launchConfig.appName);

  const store = await loadShortcuts(shortcutsPath);
  const existingIndex = Object.keys(store).find((key) => {
    const item = store[key];
    return item && item.appname === launchConfig.appName && item.exe === launchConfig.exe;
  });

  const nextIndex =
    existingIndex !== undefined
      ? existingIndex
      : String(
          Object.keys(store)
            .map((k) => Number.parseInt(k, 10))
            .filter((n) => Number.isFinite(n))
            .reduce((max, n) => Math.max(max, n), -1) + 1
        );

  store[nextIndex] = {
    appname: launchConfig.appName,
    exe: launchConfig.exe,
    StartDir: launchConfig.startDir,
    icon: launchConfig.icon,
    ShortcutPath: "",
    LaunchOptions: launchConfig.launchOptions,
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: 1,
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: "",
    DevkitOverrideAppID: 0,
    LastPlayTime: 0,
    FlatpakAppID: "",
    tags: {
      0: MANAGED_TAG
    },
    appid
  };

  const encoded = encodeShortcuts(store);
  await fs.writeFile(shortcutsPath, encoded);

  return {
    appName: launchConfig.appName,
    shortcutId: appid,
    userId: context.userId,
    steamPath: context.steamPath,
    gridDir
  };
}

async function listManagedShortcuts() {
  const context = await getSteamContext();
  const store = await loadShortcuts(context.shortcutsPath);

  const entries = Object.entries(store)
    .filter(([, item]) => item && hasManagedTag(item))
    .map(([index, item]) => ({
      index,
      appName: item.appname || "Unknown Game",
      shortcutId: getShortcutId(item),
      exePath: unquote(item.exe || ""),
      isVr: Number(item.OpenVR) === 1,
      gridDir: context.gridDir,
      userId: context.userId
    }))
    .sort((a, b) => Number.parseInt(b.index, 10) - Number.parseInt(a.index, 10));

  return entries;
}

async function setManagedShortcutVr(shortcutId, enabled) {
  const id = toUInt32(shortcutId);
  const context = await getSteamContext();
  const store = await loadShortcuts(context.shortcutsPath);

  const entry = Object.entries(store).find(([, item]) => item && hasManagedTag(item) && getShortcutId(item) === id);
  if (!entry) {
    return null;
  }

  const [, item] = entry;
  const isVr = Boolean(enabled);
  item.OpenVR = isVr ? 1 : 0;

  const encoded = encodeShortcuts(store);
  await fs.writeFile(context.shortcutsPath, encoded);

  return {
    appName: item.appname || "Unknown Game",
    shortcutId: getShortcutId(item),
    isVr
  };
}

async function removeManagedShortcut(shortcutId) {
  const id = toUInt32(shortcutId);
  const context = await getSteamContext();
  const store = await loadShortcuts(context.shortcutsPath);

  const entry = Object.entries(store).find(([, item]) => item && hasManagedTag(item) && getShortcutId(item) === id);
  if (!entry) {
    return null;
  }

  const [index, item] = entry;
  delete store[index];

  const encoded = encodeShortcuts(store);
  await fs.writeFile(context.shortcutsPath, encoded);

  return {
    appName: item.appname || "Unknown Game",
    shortcutId: id,
    gridDir: context.gridDir
  };
}

async function renameManagedShortcut(shortcutId, nextAppName) {
  const id = toUInt32(shortcutId);
  const normalizedName = sanitizeRenamedTitle(nextAppName);
  const context = await getSteamContext();
  const store = await loadShortcuts(context.shortcutsPath);

  const entry = Object.entries(store).find(([, item]) => item && hasManagedTag(item) && getShortcutId(item) === id);
  if (!entry) {
    return null;
  }

  const [index, item] = entry;
  const previousAppName = item.appname || "Unknown Game";
  const previousShortcutId = getShortcutId(item);
  const nextShortcutId = computeShortcutAppId(item.exe || "", normalizedName);

  const conflict = Object.entries(store).find(
    ([candidateIndex, candidate]) =>
      candidateIndex !== index && candidate && getShortcutId(candidate) === nextShortcutId
  );
  if (conflict) {
    throw new Error("A Steam shortcut with that name already exists.");
  }

  item.appname = normalizedName;
  item.appid = nextShortcutId;

  const encoded = encodeShortcuts(store);
  await fs.writeFile(context.shortcutsPath, encoded);

  return {
    appName: normalizedName,
    previousAppName,
    shortcutId: nextShortcutId,
    previousShortcutId,
    gridDir: context.gridDir,
    userId: context.userId
  };
}

async function removeAllManagedShortcuts() {
  const context = await getSteamContext();
  const store = await loadShortcuts(context.shortcutsPath);

  const removed = [];
  for (const [index, item] of Object.entries(store)) {
    if (!item || !hasManagedTag(item)) {
      continue;
    }

    removed.push({
      appName: item.appname || "Unknown Game",
      shortcutId: getShortcutId(item),
      gridDir: context.gridDir
    });
    delete store[index];
  }

  const encoded = encodeShortcuts(store);
  await fs.writeFile(context.shortcutsPath, encoded);

  return removed;
}

async function getSteamContext() {
  const steamPath = getSteamInstallPath();
  const { userId, configDir } = await resolveUserConfigDir(steamPath);
  return {
    steamPath,
    userId,
    configDir,
    shortcutsPath: path.join(configDir, "shortcuts.vdf"),
    gridDir: path.join(configDir, "grid")
  };
}

async function buildLaunchConfig(input) {
  if (input.kind !== "exe" && input.kind !== "file") {
    throw new Error("Unsupported file type.");
  }

  const sourcePath = path.resolve(input.value);
  await assertExists(sourcePath, "File not found.");
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  const exePath = await resolveExecutablePath(sourcePath);

  const rawName =
    sourceExtension === ".lnk"
      ? path.basename(sourcePath, path.extname(sourcePath))
      : path.basename(exePath, path.extname(exePath));
  const appName = sanitizeTitle(rawName.replace(/[.]+/g, " "));

  return {
    appName,
    exe: quote(exePath),
    startDir: quote(path.dirname(exePath)),
    icon: exePath,
    launchOptions: ""
  };
}

async function resolveExecutablePath(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".exe") {
    return sourcePath;
  }

  if (extension !== ".lnk") {
    throw new Error("Only .exe and .lnk files are supported.");
  }

  const resolved = await resolveShortcutTarget(sourcePath);
  if (!resolved) {
    throw new Error("Shortcut target could not be resolved.");
  }

  const targetPath = path.resolve(resolved);
  await assertExists(targetPath, "Shortcut target not found.");

  if (path.extname(targetPath).toLowerCase() !== ".exe") {
    throw new Error("Shortcut target is not an .exe file.");
  }

  return targetPath;
}

function resolveShortcutTarget(shortcutPath) {
  const escaped = shortcutPath.replace(/'/g, "''");
  const command =
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${escaped}');` +
    `if($s -and $s.TargetPath){[Console]::Write($s.TargetPath)}`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error("Failed to read shortcut target."));
          return;
        }

        resolve(String(stdout || "").trim());
      }
    );
  });
}

function getSteamInstallPath() {
  const candidates = [
    process.env.STEAM_PATH,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Steam") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Steam") : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      require("fs").accessSync(candidate);
      return candidate;
    } catch {
      // Try next.
    }
  }

  throw new Error("Steam install path not found. Set STEAM_PATH env var.");
}

async function resolveUserConfigDir(steamPath) {
  const userdataDir = path.join(steamPath, "userdata");
  const entries = await fs.readdir(userdataDir, { withFileTypes: true });
  const userDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name);

  if (userDirs.length === 0) {
    throw new Error("No Steam userdata directory found.");
  }

  let best = null;
  for (const userId of userDirs) {
    const configDir = path.join(userdataDir, userId, "config");
    try {
      const stat = await fs.stat(configDir);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { userId, configDir, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Ignore invalid entries.
    }
  }

  if (!best) {
    throw new Error("No valid Steam config directory found.");
  }

  return { userId: best.userId, configDir: best.configDir };
}

async function loadShortcuts(shortcutsPath) {
  try {
    const data = await fs.readFile(shortcutsPath);
    return parseShortcuts(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseShortcuts(buffer) {
  let offset = 0;

  const readByte = () => {
    if (offset >= buffer.length) {
      throw new Error("Unexpected EOF while reading shortcuts.vdf");
    }
    return buffer[offset++];
  };

  const readCString = () => {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0x00) {
      end += 1;
    }
    if (end >= buffer.length) {
      throw new Error("Missing string terminator in shortcuts.vdf");
    }
    const value = buffer.toString("utf8", offset, end);
    offset = end + 1;
    return value;
  };

  const readObject = () => {
    const obj = {};
    while (offset < buffer.length) {
      const type = readByte();
      if (type === TYPE_END) {
        return obj;
      }

      if (type === TYPE_OBJECT) {
        const key = readCString();
        obj[key] = readObject();
        continue;
      }

      if (type === TYPE_STRING) {
        const key = readCString();
        obj[key] = readCString();
        continue;
      }

      if (type === TYPE_INT) {
        const key = readCString();
        if (offset + 4 > buffer.length) {
          throw new Error("Invalid int payload in shortcuts.vdf");
        }
        obj[key] = buffer.readUInt32LE(offset);
        offset += 4;
        continue;
      }

      throw new Error(`Unsupported VDF field type: ${type}`);
    }

    return obj;
  };

  const root = readObject();
  if (root.shortcuts && typeof root.shortcuts === "object") {
    return root.shortcuts;
  }

  return root;
}

function encodeShortcuts(store) {
  const chunks = [];

  const pushByte = (value) => {
    chunks.push(Buffer.from([value]));
  };

  const pushCString = (value) => {
    chunks.push(Buffer.from(String(value), "utf8"));
    chunks.push(Buffer.from([0x00]));
  };

  const writeObject = (obj) => {
    for (const key of Object.keys(obj)) {
      const value = obj[key];

      if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
        pushByte(TYPE_OBJECT);
        pushCString(key);
        writeObject(value);
        continue;
      }

      if (Number.isInteger(value)) {
        pushByte(TYPE_INT);
        pushCString(key);
        const intBuf = Buffer.alloc(4);
        intBuf.writeUInt32LE(value >>> 0, 0);
        chunks.push(intBuf);
        continue;
      }

      pushByte(TYPE_STRING);
      pushCString(key);
      pushCString(value ?? "");
    }

    pushByte(TYPE_END);
  };

  const indexes = Object.keys(store)
    .map((key) => Number.parseInt(key, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  pushByte(TYPE_OBJECT);
  pushCString("shortcuts");

  for (const index of indexes) {
    pushByte(TYPE_OBJECT);
    pushCString(String(index));
    writeObject(store[String(index)]);
  }

  pushByte(TYPE_END);
  pushByte(TYPE_END);

  return Buffer.concat(chunks);
}

function computeShortcutAppId(exe, appName) {
  const input = `${exe}${appName}`;
  const crc = crc32(input);
  return (crc | 0x80000000) >>> 0;
}

function getShortcutId(item) {
  if (Number.isInteger(item?.appid)) {
    return toUInt32(item.appid);
  }

  return computeShortcutAppId(item?.exe || "", item?.appname || "");
}

function hasManagedTag(item) {
  const tags = item?.tags;
  if (!tags || typeof tags !== "object") {
    return false;
  }

  return Object.values(tags).some((value) => {
    const normalized = String(value).trim();
    return normalized === MANAGED_TAG || normalized === LEGACY_MANAGED_TAG;
  });
}

function toUInt32(value) {
  return Number(value) >>> 0;
}

function crc32(text) {
  const table = getCrcTable();
  let crc = 0xffffffff;

  for (let i = 0; i < text.length; i += 1) {
    const byte = text.charCodeAt(i);
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

let crcTableCache = null;
function getCrcTable() {
  if (crcTableCache) {
    return crcTableCache;
  }

  const table = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }

  crcTableCache = table;
  return table;
}

function quote(value) {
  return `"${value}"`;
}

function unquote(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1);
  }
  return text;
}

async function assertExists(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(message);
  }
}

function sanitizeTitle(raw) {
  const normalized = decodeURIComponent(raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Web Game Shortcut";
  }

  return normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function sanitizeRenamedTitle(raw) {
  const normalized = String(raw || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("App name cannot be empty.");
  }

  return normalized;
}

module.exports = {
  addShortcutForInput,
  listManagedShortcuts,
  removeManagedShortcut,
  renameManagedShortcut,
  setManagedShortcutVr,
  removeAllManagedShortcuts
};
