// Save-folder auto-detection from the Ludusavi manifest (save locations for ~20k games,
// sourced from PCGamingWiki). Downloaded once a week into the app data folder.
//
// ponytail: line scanner instead of a YAML parser. The manifest is machine-generated with a
// fixed 2-space layout; if upstream ever changes that, detection returns nothing and the
// user falls back to picking the folder by hand.

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { tokenizePath, resolveToken } = require("./saveSync");

const MANIFEST_URL = "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Manifest placeholders we can map onto our portable tokens (Windows layout, Proton prefix on Linux).
const PLACEHOLDERS = {
  "<base>": "GameDir",
  "<home>": "Home",
  "<winAppData>": "AppData",
  "<winLocalAppData>": "LocalAppData",
  "<winDocuments>": "Documents"
};

function normalizeName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function unquoteKey(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

// Returns { byName: Map<normName, game>, bySteamId: Map<id, game> } for games that list files.
function parseManifest(text) {
  const byName = new Map();
  const bySteamId = new Map();
  let game = null;
  let section = null;
  let entry = null;
  let sub = null;
  let when = null;

  const finish = () => {
    if (!game) return;
    game.files = game.files.filter(
      (f) => f.whens.length === 0 || f.whens.some((w) => (!w.os || w.os === "windows") && w.store !== "microsoft")
    );
    if (game.files.length === 0) return;
    byName.set(normalizeName(game.name), game);
    if (game.steamId) bySteamId.set(game.steamId, game);
  };

  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^(\S.*):\s*$/.exec(line))) {
      finish();
      game = { name: unquoteKey(m[1]), steamId: null, files: [] };
      section = entry = sub = when = null;
    } else if (!game) {
      continue;
    } else if ((m = /^ {2}(\w+):/.exec(line))) {
      section = m[1];
      entry = sub = when = null;
    } else if (section === "files" && (m = /^ {4}(\S.*):\s*$/.exec(line))) {
      entry = { path: unquoteKey(m[1]), save: false, whens: [] };
      game.files.push(entry);
      sub = when = null;
    } else if (section === "files" && entry && (m = /^ {6}(tags|when):/.exec(line))) {
      sub = m[1];
    } else if (section === "files" && entry && sub === "tags" && /^ {8}- save\s*$/.test(line)) {
      entry.save = true;
    } else if (section === "files" && entry && sub === "when" && (m = /^ {8}- (\w+): (.*)$/.exec(line))) {
      when = { [m[1]]: m[2].trim() };
      entry.whens.push(when);
    } else if (section === "files" && when && (m = /^ {10}(\w+): (.*)$/.exec(line))) {
      when[m[1]] = m[2].trim();
    } else if (section === "steam" && (m = /^ {4}id: (\d+)/.exec(line))) {
      game.steamId = Number(m[1]);
    }
  }
  finish();
  return { byName, bySteamId };
}

// Turns manifest file entries into sync-folder candidates, best first.
function saveFolderCandidates(game, bases, pathImpl = path) {
  const seen = new Map();
  for (const file of game.files) {
    const m = /^(<\w+>)(.*)$/.exec(file.path);
    const baseName = m && PLACEHOLDERS[m[1]];
    if (!baseName || !bases[baseName] || m[2].includes("<")) continue;

    const segments = m[2].split("/").filter(Boolean);
    const globAt = segments.findIndex((s) => /[*?[\]{}]/.test(s));
    let parts = globAt >= 0 ? segments.slice(0, globAt) : segments;
    let absPath = pathImpl.join(bases[baseName], ...parts);
    let exists = fsSync.existsSync(absPath);
    // A literal file path: sync the folder that holds it.
    if (globAt < 0 && parts.length > 0) {
      const isFile = exists ? fsSync.statSync(absPath).isFile() : /\.\w{1,10}$/.test(parts[parts.length - 1]);
      if (isFile) {
        parts = parts.slice(0, -1);
        absPath = pathImpl.join(bases[baseName], ...parts);
        exists = fsSync.existsSync(absPath);
      }
    }

    let token;
    try {
      token = tokenizePath(absPath, bases, pathImpl);
    } catch {
      continue;
    }
    // Never suggest syncing a whole base folder (all of Documents, the whole game install, ...).
    const depth = token.split("/").length - 1;
    if (depth < (token.startsWith("{Home}") ? 2 : 1)) continue;

    const score = (exists ? 4 : 0) + (file.save ? 2 : 0);
    const prev = seen.get(token);
    if (!prev || prev.score < score) seen.set(token, { token, absPath, exists, save: file.save, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

let parsedCache = null;

async function loadManifest(cacheDir) {
  const file = path.join(cacheDir, "ludusavi-manifest.yaml");
  let stat = await fs.stat(file).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs > MAX_AGE_MS) {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      stat = await fs.stat(file);
    } catch (error) {
      if (!stat) throw new Error(`Could not download the save-location list: ${error.message}`);
      // Offline: keep using the stale copy.
    }
  }
  if (!parsedCache || parsedCache.mtimeMs !== stat.mtimeMs) {
    parsedCache = { mtimeMs: stat.mtimeMs, index: parseManifest(await fs.readFile(file, "utf8")) };
  }
  return parsedCache.index;
}

// Best guess for a game's save folder, or null. `steamId` is an optional fallback match.
async function detectSaveFolder({ name, steamId, bases, cacheDir }) {
  const index = await loadManifest(cacheDir);
  const game = index.byName.get(normalizeName(name)) || (steamId ? index.bySteamId.get(Number(steamId)) : null);
  if (!game) return null;
  const candidates = saveFolderCandidates(game, bases);
  return candidates.length ? { manifestName: game.name, best: candidates[0], candidates } : null;
}

module.exports = { detectSaveFolder, parseManifest, saveFolderCandidates, normalizeName, resolveToken };

if (require.main === module) {
  const assert = require("assert");
  const sample = [
    "---",
    "Hollow Knight:",
    "  files:",
    '    "<base>/hollow_knight_Data/Config.ini":',
    "      tags:",
    "        - config",
    "      when:",
    "        - os: windows",
    "        - os: linux",
    '    "<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat":',
    "      tags:",
    "        - save",
    "      when:",
    "        - os: windows",
    '    "<xdgConfig>/unity3d/Team Cherry/Hollow Knight/*.dat":',
    "      when:",
    "        - os: linux",
    '    "<winProgramData>/Packages/x/wgs":',
    "      when:",
    "        - os: windows",
    "          store: microsoft",
    '    "<winDocuments>/*.sav":',
    "      tags:",
    "        - save",
    "  steam:",
    "    id: 367520",
    '"Café: The Game":',
    "  files:",
    '    "<winAppData>/Cafe":',
    "      tags:",
    "        - save",
    "No Files Game:",
    "  steam:",
    "    id: 1"
  ].join("\n");

  const index = parseManifest(sample);
  assert.strictEqual(index.byName.size, 2);
  const hk = index.bySteamId.get(367520);
  assert.strictEqual(hk.name, "Hollow Knight");
  assert.strictEqual(hk.files.length, 3); // linux-only and microsoft-store entries dropped
  assert.ok(index.byName.get(normalizeName("Cafe - the game")));

  const bases = {
    GameDir: "C:\\Games\\HK",
    LocalLow: "C:\\Users\\u\\AppData\\LocalLow",
    LocalAppData: "C:\\Users\\u\\AppData\\Local",
    AppData: "C:\\Users\\u\\AppData\\Roaming",
    Documents: "C:\\Users\\u\\Documents",
    Home: "C:\\Users\\u"
  };
  const candidates = saveFolderCandidates(hk, bases, path.win32);
  assert.deepStrictEqual(
    candidates.map((c) => c.token),
    ["{LocalLow}/Team Cherry/Hollow Knight", "{GameDir}/hollow_knight_Data"]
  ); // save-tagged first; "<winDocuments>/*.sav" rejected as the whole Documents folder
  console.log("saveLocations ok");
}
