const dropZone = document.getElementById("dropZone");
const gamesGrid = document.getElementById("gamesGrid");
const dragOverlay = document.getElementById("dragOverlay");
const statusLog = document.getElementById("statusLog");
const sortSelect = document.getElementById("sortSelect");
const restartSteamBtn = document.getElementById("restartSteamBtn");
const removeAllBtn = document.getElementById("removeAllBtn");
const progressWrap = document.getElementById("progressWrap");
const progressLabel = document.getElementById("progressLabel");
const progressPct = document.getElementById("progressPct");
const progressFill = document.getElementById("progressFill");
const gameMenu = createGameContextMenu();
const renameDialog = createRenameDialog();
let menuTarget = null;
let allGamesCache = [];

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  statusLog.textContent += `\n[${timestamp}] ${message}`;
  statusLog.scrollTop = statusLog.scrollHeight;
}

function prettyGameName(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function setProgressState({ visible, label, done, total }) {
  progressWrap.hidden = !visible;
  if (!visible) {
    return;
  }

  const safeTotal = Math.max(1, Number(total) || 1);
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
  const pct = Math.round((safeDone / safeTotal) * 100);

  progressLabel.textContent = label || "Working...";
  progressPct.textContent = `${pct}%`;
  progressFill.style.width = `${pct}%`;
}

async function refreshGames() {
  const response = await window.steamDrop.listGames();
  if (!response.ok) {
    log(`ERROR: ${response.error || "Failed to load games."}`);
    return;
  }

  allGamesCache = Array.isArray(response.games) ? response.games : [];
  renderSortedGames();
}

function renderSortedGames() {
  const sortMode = sortSelect ? sortSelect.value : "added_desc";
  renderGames(sortGames(allGamesCache, sortMode));
}

function sortGames(games, mode) {
  const list = Array.isArray(games) ? [...games] : [];
  const byName = (a, b) => getDisplayName(a.appName).localeCompare(getDisplayName(b.appName), undefined, { sensitivity: "base" });

  switch (mode) {
    case "added_asc":
      return list.reverse();
    case "name_asc":
      return list.sort(byName);
    case "name_desc":
      return list.sort((a, b) => byName(b, a));
    case "vr_first":
      return list.sort((a, b) => {
        if (Boolean(a.isVr) !== Boolean(b.isVr)) {
          return a.isVr ? -1 : 1;
        }
        return byName(a, b);
      });
    case "added_desc":
    default:
      return list;
  }
}

function renderGames(games) {
  gamesGrid.innerHTML = "";
  hideGameMenu();

  if (games.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-card";
    empty.textContent = "No games added yet.";
    gamesGrid.appendChild(empty);
    return;
  }

  for (const game of games) {
    const displayName = getDisplayName(game.appName);
    const card = document.createElement("article");
    card.className = "game-card";
    card.title = `${displayName}\nRight-click for options`;

    if (game.isVr) {
      const vrBadge = document.createElement("span");
      vrBadge.className = "vr-badge";
      vrBadge.textContent = "VR";
      card.appendChild(vrBadge);
    }

    const cover = document.createElement("div");
    cover.className = "game-cover";

    if (game.coverPath) {
      const image = document.createElement("img");
      image.src = `file:///${game.coverPath.replace(/\\/g, "/")}`;
      image.alt = displayName;
      image.draggable = false;
      image.addEventListener("dragstart", (event) => event.preventDefault());
      cover.appendChild(image);
    } else {
      cover.classList.add("placeholder");
      cover.textContent = displayName.slice(0, 1).toUpperCase();
    }

    const name = document.createElement("p");
    name.className = "game-name";
    name.textContent = displayName;

    card.appendChild(cover);
    card.appendChild(name);

    card.addEventListener("contextmenu", async (event) => {
      event.preventDefault();
      showGameMenu(card, game, displayName);
    });

    gamesGrid.appendChild(card);
  }
}

function setDragActive(active) {
  dragOverlay.hidden = !active;
  dropZone.classList.toggle("active", active);
}

dropZone.addEventListener("click", async () => {
  const picked = await window.steamDrop.pickExes();
  if (!picked || picked.canceled || !Array.isArray(picked.paths) || picked.paths.length === 0) {
    return;
  }

  await processExeBatch(picked.paths, "Adding selected games");
});

dropZone.addEventListener("dragenter", (event) => {
  event.preventDefault();
  setDragActive(true);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
});

dropZone.addEventListener("dragleave", (event) => {
  if (event.relatedTarget && dropZone.contains(event.relatedTarget)) {
    return;
  }
  setDragActive(false);
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  setDragActive(false);

  const paths = await getDroppedExePaths(event.dataTransfer);
  if (paths.length === 0) {
    log("Unsupported drop. Use .exe or .lnk files.");
    return;
  }

  await processExeBatch(paths, "Adding dropped games");
});

restartSteamBtn.addEventListener("click", async () => {
  log("Restarting Steam...");
  const response = await window.steamDrop.restartSteam();
  if (!response.ok) {
    log(`ERROR: ${response.error || "Failed to restart Steam."}`);
    return;
  }

  log("Steam restarted.");
});

removeAllBtn.addEventListener("click", async () => {
  const confirmAll = window.confirm("Remove all Steam Drop shortcuts and artwork?");
  if (!confirmAll) {
    return;
  }

  const response = await window.steamDrop.removeAll();
  if (!response.ok) {
    log(`ERROR: ${response.error || "Could not remove all games."}`);
    return;
  }

  log(`Removed ${response.removedCount} game(s).`);
  await refreshGames();
});

async function processExeBatch(paths, label) {
  const uniquePaths = Array.from(new Set(paths));
  setProgressState({ visible: true, label: label || "Adding games", done: 0, total: uniquePaths.length });

  for (let i = 0; i < uniquePaths.length; i += 1) {
    const exePath = uniquePaths[i];
    await processExe(exePath);
    setProgressState({
      visible: true,
      label: `${label || "Adding games"} (${i + 1}/${uniquePaths.length})`,
      done: i + 1,
      total: uniquePaths.length
    });
  }

  await refreshGames();
  setTimeout(() => setProgressState({ visible: false, done: 0, total: 1 }), 900);
}

async function getDroppedExePaths(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }

  const results = new Set();

  for (const file of Array.from(dataTransfer.files || [])) {
    const directPath = typeof file.path === "string" ? file.path : "";
    const bridgedPath = await tryGetPathForFile(file);
    const filePath = directPath || bridgedPath;
    if (isSupportedGameFile(filePath)) {
      results.add(filePath);
    }
  }

  const textData = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain") || "";
  for (const line of textData.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
    const maybePath = fileUriToPath(line);
    if (isSupportedGameFile(maybePath)) {
      results.add(maybePath);
    }
  }

  return Array.from(results);
}

async function tryGetPathForFile(file) {
  try {
    if (!window.steamDrop || typeof window.steamDrop.getPathForFile !== "function") {
      return "";
    }
    const value = await window.steamDrop.getPathForFile(file);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function fileUriToPath(value) {
  if (!value.toLowerCase().startsWith("file://")) {
    return null;
  }

  try {
    const url = new URL(value);
    let pathname = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname.replace(/\//g, "\\");
  } catch {
    return null;
  }
}

async function processExe(exePath) {
  log(`Processing file: ${exePath}`);

  const response = await window.steamDrop.process({ kind: "file", value: exePath });
  if (!response.ok) {
    log(`ERROR: ${response.error || "Unknown error"}`);
    return;
  }

  const result = response.result;
  const displayName = prettyGameName(result.appName);
  log(`Added shortcut: ${displayName}`);
  log(`Artwork source: ${result.artworkSource}`);
  log(`Saved ${result.savedArtwork.length} artwork file(s).`);

  if (Array.isArray(result.notes)) {
    for (const note of result.notes) {
      log(note);
    }
  }
}

function getDisplayName(name) {
  const value = String(name || "").trim();
  return value || "Unknown Game";
}

function createGameContextMenu() {
  const menu = document.createElement("div");
  menu.className = "game-context-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <label class="menu-toggle" title="Mark this shortcut as VR in Steam">
      <input type="checkbox" data-role="vr-toggle" />
      <span>VR Game</span>
    </label>
    <div class="menu-divider"></div>
    <button type="button" data-action="rename">Rename</button>
    <button type="button" data-action="delete" class="danger">Delete</button>
  `;

  menu.addEventListener("change", async (event) => {
    const toggle = event.target.closest('input[data-role="vr-toggle"]');
    if (!toggle || !menuTarget) {
      return;
    }

    const target = menuTarget;
    const nextVr = Boolean(toggle.checked);
    await setVrFromMenu(target.game, target.displayName, nextVr);
  });

  menu.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton || !menuTarget) {
      return;
    }

    const target = menuTarget;
    hideGameMenu();

    if (actionButton.dataset.action === "delete") {
      await removeGameFromMenu(target.game, target.displayName);
      return;
    }

    if (actionButton.dataset.action === "rename") {
      await renameGameFromMenu(target.game, target.displayName);
    }
  });

  document.body.appendChild(menu);
  return menu;
}

function showGameMenu(cardElement, game, displayName) {
  menuTarget = { game, displayName, cardElement };
  const vrToggle = gameMenu.querySelector('input[data-role="vr-toggle"]');
  if (vrToggle) {
    vrToggle.checked = Boolean(game.isVr);
  }

  gameMenu.hidden = false;

  const cardRect = cardElement.getBoundingClientRect();
  const rect = gameMenu.getBoundingClientRect();
  const targetX = cardRect.left + 8;
  const targetY = cardRect.top + 8;
  const clampedX = Math.max(10, Math.min(targetX, window.innerWidth - rect.width - 10));
  const clampedY = Math.max(10, Math.min(targetY, window.innerHeight - rect.height - 10));
  gameMenu.style.left = `${clampedX}px`;
  gameMenu.style.top = `${clampedY}px`;
}

function hideGameMenu() {
  menuTarget = null;
  gameMenu.hidden = true;
}

async function removeGameFromMenu(game, displayName) {
  const confirmed = window.confirm(`Remove "${displayName}" from Steam shortcuts?`);
  if (!confirmed) {
    return;
  }

  const removed = await window.steamDrop.removeGame(game.shortcutId);
  if (!removed.ok) {
    log(`ERROR: ${removed.error || "Could not remove game."}`);
    return;
  }

  log(`Removed shortcut: ${displayName}`);
  await refreshGames();
}

async function renameGameFromMenu(game, displayName) {
  if (!window.steamDrop || typeof window.steamDrop.renameGame !== "function") {
    log("ERROR: Rename API is unavailable. Restart the app and try again.");
    return;
  }

  const nextName = await showRenameDialog(displayName, game.exePath);
  if (nextName === null) {
    return;
  }

  const trimmed = String(nextName).trim();
  if (!trimmed) {
    log("ERROR: App name cannot be empty.");
    return;
  }

  setProgressState({ visible: true, label: `Renaming ${displayName}`, done: 0, total: 1 });

  let renamed;
  try {
    renamed = await window.steamDrop.renameGame(game.shortcutId, trimmed);
  } catch {
    log("ERROR: Rename request failed.");
    setProgressState({ visible: false, done: 0, total: 1 });
    return;
  }

  if (!renamed.ok) {
    log(`ERROR: ${renamed.error || "Could not rename game."}`);
    setProgressState({ visible: false, done: 0, total: 1 });
    return;
  }

  const result = renamed.result || {};
  log(`Renamed shortcut: ${displayName} -> ${result.appName || trimmed}`);
  log(`Artwork source: ${result.artworkSource || "none"}`);
  log(`Saved ${(result.savedArtwork || []).length} artwork file(s).`);

  if (Array.isArray(result.notes)) {
    for (const note of result.notes) {
      log(note);
    }
  }

  setProgressState({ visible: true, label: `Renaming ${displayName}`, done: 1, total: 1 });
  await refreshGames();
  setTimeout(() => setProgressState({ visible: false, done: 0, total: 1 }), 700);
}

async function setVrFromMenu(game, displayName, isVr) {
  if (!window.steamDrop || typeof window.steamDrop.setGameVr !== "function") {
    log("ERROR: VR update API is unavailable. Restart the app and try again.");
    return;
  }

  const response = await window.steamDrop.setGameVr(game.shortcutId, isVr);
  if (!response.ok) {
    log(`ERROR: ${response.error || "Could not update VR status."}`);
    return;
  }

  game.isVr = isVr;
  for (const item of allGamesCache) {
    if (Number(item.shortcutId) === Number(game.shortcutId)) {
      item.isVr = isVr;
      break;
    }
  }

  renderSortedGames();
  log(`${displayName} marked as ${isVr ? "VR" : "non-VR"} in Steam.`);
}

function createRenameDialog() {
  const dialog = document.createElement("div");
  dialog.className = "rename-dialog";
  dialog.hidden = true;
  dialog.innerHTML = `
    <div class="rename-dialog-backdrop" data-role="backdrop"></div>
    <div class="rename-dialog-panel" role="dialog" aria-modal="true" aria-label="Rename game">
      <h3>Rename Game</h3>
      <p>Choose the new app name for Steam.</p>
      <p class="rename-path-label">Stored path</p>
      <p class="rename-path" data-role="path"></p>
      <input type="text" data-role="input" maxlength="120" />
      <div class="rename-dialog-actions">
        <button type="button" data-role="cancel">Cancel</button>
        <button type="button" data-role="save">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);
  return dialog;
}

function showRenameDialog(currentName, storedPath) {
  return new Promise((resolve) => {
    const input = renameDialog.querySelector('[data-role="input"]');
    const save = renameDialog.querySelector('[data-role="save"]');
    const cancel = renameDialog.querySelector('[data-role="cancel"]');
    const backdrop = renameDialog.querySelector('[data-role="backdrop"]');
    const pathLine = renameDialog.querySelector('[data-role="path"]');

    if (!input || !save || !cancel || !backdrop || !pathLine) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      renameDialog.hidden = true;
      save.removeEventListener("click", onSave);
      cancel.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onInputKeyDown);
      document.removeEventListener("keydown", onEscKey);
      resolve(value);
    };

    const onSave = () => finish(input.value);
    const onCancel = () => finish(null);
    const onInputKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSave();
      }
    };
    const onEscKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    renameDialog.hidden = false;
    input.value = currentName;
    pathLine.textContent = storedPath ? String(storedPath) : "Unknown";
    input.focus();
    input.select();

    save.addEventListener("click", onSave);
    cancel.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onCancel);
    input.addEventListener("keydown", onInputKeyDown);
    document.addEventListener("keydown", onEscKey);
  });
}

function isSupportedGameFile(filePath) {
  if (!filePath) {
    return false;
  }
  const normalized = String(filePath).toLowerCase();
  return normalized.endsWith(".exe") || normalized.endsWith(".lnk");
}

document.addEventListener("click", (event) => {
  if (!gameMenu.hidden && !gameMenu.contains(event.target)) {
    hideGameMenu();
  }
});

document.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".game-card")) {
    hideGameMenu();
  }
});

window.addEventListener("blur", hideGameMenu);
window.addEventListener("resize", hideGameMenu);
document.addEventListener("scroll", hideGameMenu, true);

if (sortSelect) {
  sortSelect.addEventListener("change", () => {
    renderSortedGames();
  });
}

refreshGames();
