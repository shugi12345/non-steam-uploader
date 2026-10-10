const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ic"><use href="#i-${name}" /></svg>`;
const dropZone = $("dropZone");
const gamesGrid = $("gamesGrid");
const dragOverlay = $("dragOverlay");
const statusLog = $("statusLog");
const activityBtn = $("activityBtn");
const activityLast = $("activityLast");
const toasts = $("toasts");
const gameCount = $("gameCount");
const sortSelect = $("sortSelect");
const sizeSelect = $("sizeSelect");
const apiKeyStatus = $("apiKeyStatus");
const steamLocationBtn = $("steamLocationBtn");
const apiKeyBtn = $("apiKeyBtn");
const restartSteamBtn = $("restartSteamBtn");
const removeAllBtn = $("removeAllBtn");
const undoBtn = $("undoBtn");
const cloudBtn = $("cloudBtn");
const progressLabel = $("progressLabel");
const progressPct = $("progressPct");
const progressFill = $("progressFill");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const gameMenu = createGameContextMenu();
let menuTarget = null;
let allGamesCache = [];
let currentGames = [];
let selectedShortcutIds = new Set();
let lastSelectedShortcutId = null;
const GRID_SIZE_STORAGE_KEY = "steamDrop.gridSize";
const MAX_UNDO_ENTRIES = 50;
let restartRequired = false;
let isUndoing = false;
const undoStack = [];
let artVersion = Date.now();
const cardCache = new Map();
const openModals = [];

function log(message) {
  const text = String(message);
  const timestamp = new Date().toLocaleTimeString();
  statusLog.textContent += `\n[${timestamp}] ${text}`;
  statusLog.scrollTop = statusLog.scrollHeight;

  const isError = text.startsWith("ERROR");
  activityLast.textContent = text;
  activityLast.classList.toggle("err", isError);
  activityLast.classList.remove("flash");
  void activityLast.offsetWidth;
  activityLast.classList.add("flash");
  if (isError) {
    toast(text.replace(/^ERROR:\s*/, ""), "err");
  }
}

// kind: ok | err | info. Optional action = { label, run } renders an inline button (e.g. Undo).
function toast(message, kind = "ok", action = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = icon(kind === "err" ? "alert" : kind === "ok" ? "check" : "refresh");
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn ghost sm";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      dismiss();
      action.run();
    });
    el.appendChild(button);
  } else {
    el.addEventListener("click", dismiss);
  }

  toasts.appendChild(el);
  while (toasts.children.length > 4) {
    toasts.firstElementChild.remove();
  }
  setTimeout(dismiss, kind === "err" ? 6500 : action ? 6000 : 3200);
}

// Swaps a button's icon for a spinner while fn runs.
async function withBusy(button, fn) {
  if (!button || button.getAttribute("aria-busy") === "true") return undefined;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  const iconEl = button.querySelector(".ic");
  if (iconEl) iconEl.replaceWith(spinner);
  else button.prepend(spinner);
  try {
    return await fn();
  } finally {
    if (iconEl) spinner.replaceWith(iconEl);
    else spinner.remove();
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
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
    .map((word) => {
      if (/^I{2,}$/i.test(word)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function setProgressState({ visible, label, done, total }) {
  dropZone.classList.toggle("busy", Boolean(visible));
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

function setRestartRequired(required) {
  restartRequired = Boolean(required);
  restartSteamBtn.classList.toggle("needs-restart", restartRequired);
  restartSteamBtn.title = restartRequired ? "Restart Steam to see your changes" : "";
}

function snapshotGameState(game) {
  return {
    shortcutId: Number(game.shortcutId),
    appName: getDisplayName(game.appName),
    exePath: String(game.exePath || "").trim(),
    isVr: Boolean(game.isVr)
  };
}

function pushUndoAction(action) {
  if (isUndoing || !action || typeof action !== "object") {
    return;
  }

  undoStack.push(action);
  if (undoStack.length > MAX_UNDO_ENTRIES) {
    undoStack.shift();
  }
  updateUndoButton();
}

function updateUndoButton() {
  const hasUndo = undoStack.length > 0;
  undoBtn.disabled = !hasUndo;
  undoBtn.title = hasUndo ? `Undo ${undoStack[undoStack.length - 1].label || "last action"} (Ctrl+Z)` : "Nothing to undo";
}

async function restoreRemovedGames(games, label) {
  const snapshots = Array.isArray(games) ? games : [];
  if (snapshots.length === 0) {
    return;
  }

  setProgressState({ visible: true, label: label || "Undoing removal", done: 0, total: snapshots.length });
  let restoredCount = 0;

  for (let i = 0; i < snapshots.length; i += 1) {
    const game = snapshots[i];
    if (!game.exePath) {
      log(`ERROR: Could not restore "${game.appName}" (missing executable path).`);
      setProgressState({ visible: true, label: label || "Undoing removal", done: i + 1, total: snapshots.length });
      continue;
    }

    const added = await window.steamDrop.process({ kind: "file", value: game.exePath });
    if (!added.ok) {
      log(`ERROR: Could not restore "${game.appName}". ${added.error || "Unknown error"}`);
      setProgressState({ visible: true, label: label || "Undoing removal", done: i + 1, total: snapshots.length });
      continue;
    }

    let currentShortcutId = Number(added.result?.shortcutId);
    const createdName = getDisplayName(added.result?.appName);

    if (game.appName && game.appName !== createdName) {
      const renamed = await window.steamDrop.renameGame(currentShortcutId, game.appName);
      if (renamed.ok) {
        currentShortcutId = Number(renamed.result?.shortcutId || currentShortcutId);
      } else {
        log(`ERROR: Restored "${createdName}", but failed to rename to "${game.appName}". ${renamed.error || ""}`.trim());
      }
    }

    if (game.isVr) {
      const vrUpdated = await window.steamDrop.setGameVr(currentShortcutId, true);
      if (!vrUpdated.ok) {
        log(`ERROR: Restored "${game.appName}", but failed to restore VR flag.`);
      }
    }

    restoredCount += 1;
    setProgressState({ visible: true, label: label || "Undoing removal", done: i + 1, total: snapshots.length });
  }

  if (restoredCount > 0) {
    setRestartRequired(true);
    log(`Undo complete: restored ${restoredCount} game(s).`);
    toast(`Restored ${plural(restoredCount, "game")}`, "info");
  }
  await refreshGames();
  setTimeout(() => setProgressState({ visible: false }), 700);
}

async function undoLastAction() {
  if (undoStack.length === 0 || isUndoing) {
    return;
  }

  const action = undoStack.pop();
  updateUndoButton();
  isUndoing = true;

  try {
    if (action.type === "rename") {
      const response = await window.steamDrop.renameGame(action.shortcutId, action.previousName);
      if (!response.ok) {
        log(`ERROR: Undo rename failed. ${response.error || "Unknown error"}`);
        return;
      }
      log(`Undo: renamed "${action.currentName}" back to "${action.previousName}".`);
      toast(`Renamed back to "${action.previousName}"`, "info");
      setRestartRequired(true);
      await refreshGames();
      return;
    }

    if (action.type === "set_vr") {
      let updated = 0;
      for (const change of action.changes || []) {
        const response = await window.steamDrop.setGameVr(change.shortcutId, change.previousIsVr);
        if (!response.ok) {
          log(`ERROR: Undo VR change failed for "${change.appName}". ${response.error || "Unknown error"}`);
          continue;
        }
        updated += 1;
      }
      if (updated > 0) {
        log(`Undo: restored VR status for ${updated} game(s).`);
        toast("VR change undone", "info");
        setRestartRequired(true);
      }
      await refreshGames();
      return;
    }

    if (action.type === "remove_many") {
      await restoreRemovedGames(action.games, "Undoing remove");
      return;
    }

    if (action.type === "add_many") {
      let removed = 0;
      for (const game of action.games || []) {
        const response = await window.steamDrop.removeGame(game.shortcutId);
        if (!response.ok) {
          log(`ERROR: Undo add failed for "${game.appName}". ${response.error || "Unknown error"}`);
          continue;
        }
        removed += 1;
      }
      if (removed > 0) {
        log(`Undo: removed ${removed} recently added game(s).`);
        toast(`Removed ${plural(removed, "game")} again`, "info");
        setRestartRequired(true);
      }
      await refreshGames();
      return;
    }
  } finally {
    isUndoing = false;
    updateUndoButton();
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

async function refreshGames() {
  const response = await window.steamDrop.listGames();
  if (!response.ok) {
    log(`ERROR: ${response.error || "Failed to load games."}`);
    return;
  }

  allGamesCache = Array.isArray(response.games) ? response.games : [];
  selectedShortcutIds = new Set(
    Array.from(selectedShortcutIds).filter((id) => allGamesCache.some((game) => Number(game.shortcutId) === Number(id)))
  );
  if (lastSelectedShortcutId !== null && !allGamesCache.some((game) => Number(game.shortcutId) === Number(lastSelectedShortcutId))) {
    lastSelectedShortcutId = null;
  }
  flip(renderSortedGames);
}

function renderSortedGames() {
  applyGridSize();
  const sortMode = sortSelect ? sortSelect.value : "added_desc";
  renderGames(sortGames(allGamesCache, sortMode));
}

// FLIP: cards that survive a re-render glide from their old spot instead of jumping.
function flip(mutate) {
  const before = new Map(Array.from(gamesGrid.children, (el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reduceMotion.matches) return;
  for (const el of gamesGrid.children) {
    const from = before.get(el);
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const scale = to.width ? from.width / to.width : 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.01) continue;
    el.animate(
      [
        { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        { transformOrigin: "top left", transform: "none" }
      ],
      { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
    );
  }
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

function updateHeaderCount() {
  const synced = allGamesCache.filter((game) => game.syncEnabled).length;
  gameCount.textContent =
    allGamesCache.length === 0
      ? "No games added yet"
      : `${plural(allGamesCache.length, "game")} in Steam${synced ? ` · ${synced} with cloud saves` : ""}`;
}

// Cards are cached by id and only rebuilt when their data changes, so re-renders don't flicker.
function renderGames(games) {
  currentGames = games;
  hideGameMenu();
  updateHeaderCount();

  if (games.length === 0) {
    cardCache.clear();
    gamesGrid.replaceChildren(createEmptyState());
    return;
  }

  const seen = new Set();
  let entering = 0;
  const elements = games.map((game) => {
    const id = Number(game.shortcutId);
    const signature = JSON.stringify([game.appName, game.coverPath, game.isVr, game.syncEnabled, game.exePath, artVersion]);
    seen.add(id);
    let entry = cardCache.get(id);
    if (!entry || entry.signature !== signature) {
      const card = buildCard(game);
      if (!entry) {
        card.classList.add("enter");
        card.style.setProperty("--delay", `${Math.min(entering, 14) * 35}ms`);
        entering += 1;
      }
      entry = { signature, card };
      cardCache.set(id, entry);
    }
    entry.card.classList.remove("leaving");
    return entry.card;
  });

  for (const id of cardCache.keys()) {
    if (!seen.has(id)) cardCache.delete(id);
  }
  gamesGrid.replaceChildren(...elements);
  updateSelectionUI();
}

function createEmptyState() {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `
    <span class="drop-icon">${icon("plus")}</span>
    <strong>Your library is empty</strong>
    <p>Drop a game's .exe anywhere in this window, and it shows up in Steam with artwork.</p>
    <button type="button" class="btn primary">${icon("folder")}Browse for games</button>
  `;
  empty.querySelector("button").addEventListener("click", pickAndAdd);
  return empty;
}

function nameHue(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function buildCard(game) {
  const displayName = getDisplayName(game.appName);
  const id = Number(game.shortcutId);
  const card = document.createElement("article");
  card.className = "game-card";
  card.tabIndex = 0;
  card.dataset.shortcutId = String(id);
  card.title = displayName;

  const cover = document.createElement("div");
  cover.className = "game-cover";
  const showPlaceholder = () => {
    cover.classList.add("placeholder");
    cover.style.setProperty("--hue", nameHue(displayName));
    const letter = document.createElement("span");
    letter.className = "placeholder-letter";
    letter.textContent = displayName.slice(0, 1).toUpperCase();
    cover.prepend(letter);
  };

  if (game.coverPath) {
    const image = document.createElement("img");
    const coverUrl = game.coverPath.replace(/\\/g, "/");
    image.alt = "";
    image.draggable = false;
    image.decoding = "async";
    image.addEventListener("load", () => image.classList.add("loaded"), { once: true });
    image.addEventListener("error", () => {
      image.remove();
      showPlaceholder();
    });
    image.src = `file://${coverUrl.startsWith("/") ? "" : "/"}${encodeURI(coverUrl)}?v=${artVersion}`;
    cover.appendChild(image);
  } else {
    showPlaceholder();
  }

  const badges = document.createElement("div");
  badges.className = "badges";
  if (game.isVr) {
    badges.insertAdjacentHTML("beforeend", `<span class="badge">${icon("vr")}VR</span>`);
  }
  if (game.syncEnabled) {
    badges.insertAdjacentHTML("beforeend", `<span class="badge sync" title="Cloud saves on">${icon("cloud")}</span>`);
  }
  cover.append(badges);
  cover.insertAdjacentHTML("beforeend", `<span class="check">${icon("check")}</span>`);

  const name = document.createElement("p");
  name.className = "game-name";
  name.textContent = displayName;
  card.append(cover, name);

  card.addEventListener("animationend", (event) => {
    if (event.target === card) card.classList.remove("enter");
  });
  card.addEventListener("click", (event) => {
    event.preventDefault();
    selectCard(id, event);
  });
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenuFor(id, event.clientX, event.clientY);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectCard(id, event);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      openMenuFor(id, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
  });
  return card;
}

function selectCard(id, event) {
  if (event.shiftKey && lastSelectedShortcutId !== null) {
    const rangeIds = getShortcutRange(currentGames, lastSelectedShortcutId, id);
    if (event.ctrlKey || event.metaKey) {
      for (const rangeId of rangeIds) {
        selectedShortcutIds.add(rangeId);
      }
    } else {
      selectedShortcutIds = new Set(rangeIds);
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (selectedShortcutIds.has(id)) {
      selectedShortcutIds.delete(id);
    } else {
      selectedShortcutIds.add(id);
    }
  } else {
    selectedShortcutIds = new Set([id]);
  }

  lastSelectedShortcutId = id;
  updateSelectionUI();
}

function openMenuFor(id, x, y) {
  if (!selectedShortcutIds.has(id)) {
    selectedShortcutIds = new Set([id]);
    lastSelectedShortcutId = id;
    updateSelectionUI();
  }
  showGameMenu(x, y, getSelectedGames());
}

function getSelectedGames() {
  return currentGames.filter((item) => selectedShortcutIds.has(Number(item.shortcutId)));
}

function updateSelectionUI() {
  for (const card of gamesGrid.querySelectorAll(".game-card")) {
    card.classList.toggle("selected", selectedShortcutIds.has(Number(card.dataset.shortcutId)));
  }
}

function clearSelection() {
  selectedShortcutIds.clear();
  lastSelectedShortcutId = null;
  updateSelectionUI();
}

function animateCardsOut(ids) {
  for (const id of ids) {
    gamesGrid.querySelector(`.game-card[data-shortcut-id="${Number(id)}"]`)?.classList.add("leaving");
  }
}

// ---------- Adding games ----------
async function pickAndAdd() {
  if (dropZone.classList.contains("busy")) return;
  const picked = await window.steamDrop.pickExes();
  if (!picked || picked.canceled || !Array.isArray(picked.paths) || picked.paths.length === 0) {
    return;
  }

  await processExeBatch(picked.paths, "Adding selected games");
}

dropZone.addEventListener("click", pickAndAdd);
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    pickAndAdd();
  }
});

// The whole window is a drop target.
let dragDepth = 0;
const setDragActive = (active) => dragOverlay.classList.toggle("show", active);

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (openModals.length > 0) return;
  dragDepth += 1;
  setDragActive(true);
});

window.addEventListener("dragover", (event) => event.preventDefault());

window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragActive(false);
});

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDragActive(false);
  if (openModals.length > 0 || dropZone.classList.contains("busy")) return;

  const paths = await getDroppedExePaths(event.dataTransfer);
  if (paths.length === 0) {
    log("ERROR: Unsupported drop. Use .exe or .lnk files.");
    return;
  }

  await processExeBatch(paths, "Adding dropped games");
});

restartSteamBtn.addEventListener("click", () =>
  withBusy(restartSteamBtn, async () => {
    log("Restarting Steam...");
    const response = await window.steamDrop.restartSteam();
    if (!response.ok) {
      log(`ERROR: ${response.error || "Failed to restart Steam."}`);
      return;
    }

    log("Steam restarted.");
    toast("Steam restarted");
    setRestartRequired(false);
  })
);

removeAllBtn.addEventListener("click", async () => {
  if (allGamesCache.length === 0) return;
  const confirmed = await confirmDialog({
    title: "Remove all games?",
    message: `This removes all ${plural(allGamesCache.length, "shortcut")} added by Non-Steam Uploader, and their artwork. You can undo it.`,
    confirmLabel: "Remove all",
    danger: true
  });
  if (!confirmed) {
    return;
  }

  const snapshots = allGamesCache.map(snapshotGameState);
  animateCardsOut(snapshots.map((game) => game.shortcutId));
  const response = await window.steamDrop.removeAll();
  if (!response.ok) {
    log(`ERROR: ${response.error || "Could not remove all games."}`);
    await refreshGames();
    return;
  }

  log(`Removed ${response.removedCount} game(s).`);
  if (response.removedCount > 0) {
    pushUndoAction({
      type: "remove_many",
      label: `remove all (${response.removedCount})`,
      games: snapshots
    });
    setRestartRequired(true);
    toast(`Removed ${plural(response.removedCount, "game")}`, "ok", { label: "Undo", run: undoLastAction });
  }
  await refreshGames();
});

undoBtn.addEventListener("click", undoLastAction);

async function processExeBatch(paths, label) {
  const uniquePaths = Array.from(new Set(paths));
  setProgressState({ visible: true, label: label || "Adding games", done: 0, total: uniquePaths.length });
  const addedGames = [];

  for (let i = 0; i < uniquePaths.length; i += 1) {
    const exePath = uniquePaths[i];
    const added = await processExe(exePath);
    if (added) {
      addedGames.push(added);
    }
    setProgressState({
      visible: true,
      label: `${label || "Adding games"} (${i + 1}/${uniquePaths.length})`,
      done: i + 1,
      total: uniquePaths.length
    });
  }

  if (addedGames.length > 0) {
    pushUndoAction({
      type: "add_many",
      label: `add (${addedGames.length})`,
      games: addedGames
    });
    toast(
      addedGames.length === 1 ? `Added ${prettyGameName(addedGames[0].appName)} to Steam` : `Added ${plural(addedGames.length, "game")} to Steam`
    );

    // New games get cloud saves automatically when the save location is known.
    if (await isCloudConnected()) {
      const syncLabel = "Setting up cloud saves";
      setProgressState({ visible: true, label: syncLabel, done: 0, total: addedGames.length });
      reportSyncResult(
        await enableSyncFor(addedGames, {
          auto: true,
          onStep: (done) => setProgressState({ visible: true, label: syncLabel, done, total: addedGames.length })
        })
      );
    }
  }

  await refreshGames();
  setTimeout(() => setProgressState({ visible: false }), 900);
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
    return /^[A-Za-z]:/.test(pathname) ? pathname.replace(/\//g, "\\") : pathname;
  } catch {
    return null;
  }
}

async function processExe(exePath) {
  log(`Processing file: ${exePath}`);

  const response = await window.steamDrop.process({ kind: "file", value: exePath });
  if (!response.ok) {
    log(`ERROR: ${response.error || "Unknown error"}`);
    return null;
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

  setRestartRequired(true);
  return {
    shortcutId: Number(result.shortcutId),
    appName: result.appName || displayName
  };
}

function getDisplayName(name) {
  const value = String(name || "").trim();
  return value || "Unknown Game";
}

function applyGridSize() {
  const size = sizeSelect && sizeSelect.value ? sizeSelect.value : "medium";
  gamesGrid.dataset.size = size;
}

function getShortcutRange(games, fromShortcutId, toShortcutId) {
  const list = Array.isArray(games) ? games : [];
  const fromIndex = list.findIndex((item) => Number(item.shortcutId) === Number(fromShortcutId));
  const toIndex = list.findIndex((item) => Number(item.shortcutId) === Number(toShortcutId));
  if (fromIndex === -1 || toIndex === -1) {
    return [Number(toShortcutId)];
  }

  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return list.slice(start, end + 1).map((item) => Number(item.shortcutId));
}

// ---------- Context menu ----------
function createGameContextMenu() {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <div class="menu-head" data-role="head"></div>
    <label class="menu-item" title="Mark this shortcut as VR in Steam">
      ${icon("vr")}<span>VR game</span>
      <input type="checkbox" class="switch" data-role="vr-toggle" />
    </label>
    <div class="menu-sep"></div>
    <button type="button" class="menu-item" data-action="rename">${icon("edit")}<span>Rename</span></button>
    <button type="button" class="menu-item" data-action="art">${icon("image")}<span>Change art</span></button>
    <button type="button" class="menu-item" data-action="sync">${icon("cloud")}<span data-role="sync-label">Turn on cloud saves</span></button>
    <div class="menu-sep"></div>
    <button type="button" class="menu-item danger" data-action="delete">${icon("trash")}<span>Remove from Steam</span></button>
  `;

  menu.addEventListener("change", async (event) => {
    const toggle = event.target.closest('input[data-role="vr-toggle"]');
    if (!toggle || !menuTarget) {
      return;
    }

    await setVrFromMenu(menuTarget.games, Boolean(toggle.checked));
  });

  menu.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("button[data-action]");
    if (!actionButton || !menuTarget) {
      return;
    }

    const target = menuTarget;
    hideGameMenu();
    const single = target.games.length === 1 ? target.games[0] : null;

    if (actionButton.dataset.action === "delete") {
      await removeGamesFromMenu(target.games);
    } else if (actionButton.dataset.action === "rename" && single) {
      await renameGameFromMenu(single, getDisplayName(single.appName));
    } else if (actionButton.dataset.action === "art" && single) {
      await showArtDialog(single);
    } else if (actionButton.dataset.action === "sync") {
      await setSyncFromMenu(target.games);
    }
  });

  document.body.appendChild(menu);
  return menu;
}

function showGameMenu(x, y, targetGames) {
  if (!Array.isArray(targetGames) || targetGames.length === 0) {
    return;
  }

  menuTarget = { games: targetGames };
  const single = targetGames.length === 1;
  gameMenu.querySelector('[data-role="head"]').textContent = single
    ? getDisplayName(targetGames[0].appName)
    : `${targetGames.length} games selected`;

  const vrToggle = gameMenu.querySelector('input[data-role="vr-toggle"]');
  const vrStates = targetGames.map((item) => Boolean(item.isVr));
  const allSame = vrStates.every((value) => value === vrStates[0]);
  vrToggle.indeterminate = !allSame;
  vrToggle.checked = allSame ? vrStates[0] : false;

  for (const action of ["rename", "art"]) {
    const button = gameMenu.querySelector(`button[data-action="${action}"]`);
    button.disabled = !single;
    button.title = single ? "" : "Select one game for this.";
  }
  const allSynced = targetGames.every((game) => game.syncEnabled);
  const notSynced = targetGames.filter((game) => !game.syncEnabled).length;
  gameMenu.querySelector('[data-role="sync-label"]').textContent = allSynced
    ? `Turn off cloud saves${single ? "" : ` (${targetGames.length})`}`
    : `Turn on cloud saves${single ? "" : ` (${notSynced})`}`;
  gameMenu.querySelector('button[data-action="delete"] span').textContent = single
    ? "Remove from Steam"
    : `Remove ${targetGames.length} from Steam`;

  // Open toward whichever side has room; the pop animation grows from the cursor corner.
  gameMenu.classList.remove("open");
  const width = gameMenu.offsetWidth;
  const height = gameMenu.offsetHeight;
  const flipX = x + width > window.innerWidth - 8;
  const flipY = y + height > window.innerHeight - 8;
  const left = Math.max(8, flipX ? x - width : x);
  const top = Math.max(8, flipY ? y - height : y);
  gameMenu.style.left = `${left}px`;
  gameMenu.style.top = `${top}px`;
  gameMenu.style.setProperty("--origin", `${flipX ? "right" : "left"} ${flipY ? "bottom" : "top"}`);
  void gameMenu.offsetWidth;
  gameMenu.classList.add("open");
}

function hideGameMenu() {
  menuTarget = null;
  gameMenu.classList.remove("open");
}

async function removeGamesFromMenu(games) {
  const targets = Array.isArray(games) ? games : [];
  if (targets.length === 0) {
    return;
  }

  const single = targets.length === 1;
  const confirmed = await confirmDialog({
    title: single ? `Remove ${getDisplayName(targets[0].appName)}?` : `Remove ${targets.length} games?`,
    message: "The Steam shortcut and its artwork are deleted. Your game files are not touched.",
    confirmLabel: "Remove",
    danger: true
  });
  if (!confirmed) {
    return;
  }

  animateCardsOut(targets.map((game) => game.shortcutId));
  const removedSnapshots = [];
  for (const game of targets) {
    const removed = await window.steamDrop.removeGame(game.shortcutId);
    if (!removed.ok) {
      log(`ERROR: ${removed.error || `Could not remove ${getDisplayName(game.appName)}.`}`);
      continue;
    }
    removedSnapshots.push(snapshotGameState(game));
    log(`Removed shortcut: ${getDisplayName(game.appName)}`);
  }

  if (removedSnapshots.length > 0) {
    pushUndoAction({
      type: "remove_many",
      label: `remove (${removedSnapshots.length})`,
      games: removedSnapshots
    });
    toast(
      removedSnapshots.length === 1 ? `Removed ${removedSnapshots[0].appName}` : `Removed ${plural(removedSnapshots.length, "game")}`,
      "ok",
      { label: "Undo", run: undoLastAction }
    );
    setRestartRequired(true);
  }

  selectedShortcutIds.clear();
  await refreshGames();
}

async function renameGameFromMenu(game, displayName) {
  const nextName = await showRenameDialog(displayName, game.exePath);
  if (nextName === null) {
    return;
  }

  const trimmed = String(nextName).trim();
  if (!trimmed) {
    log("ERROR: App name cannot be empty.");
    return;
  }
  if (trimmed === displayName) {
    return;
  }

  setProgressState({ visible: true, label: `Renaming ${displayName}`, done: 0, total: 1 });

  let renamed;
  try {
    renamed = await window.steamDrop.renameGame(game.shortcutId, trimmed);
  } catch {
    renamed = { ok: false, error: "Rename request failed." };
  }

  if (!renamed.ok) {
    log(`ERROR: ${renamed.error || "Could not rename game."}`);
    setProgressState({ visible: false });
    return;
  }

  const result = renamed.result || {};
  log(`Renamed shortcut: ${displayName} -> ${result.appName || trimmed}`);
  if (game.syncEnabled) {
    log("  Cloud saves now use the new name. Use the same name on your other devices.");
  }
  log(`Artwork source: ${result.artworkSource || "none"}`);
  log(`Saved ${(result.savedArtwork || []).length} artwork file(s).`);

  if (Array.isArray(result.notes)) {
    for (const note of result.notes) {
      log(note);
    }
  }

  pushUndoAction({
    type: "rename",
    label: "rename",
    shortcutId: Number(result.shortcutId || game.shortcutId),
    previousName: result.previousAppName || displayName,
    currentName: result.appName || trimmed
  });

  setProgressState({ visible: true, label: `Renaming ${displayName}`, done: 1, total: 1 });
  toast(`Renamed to ${result.appName || trimmed}`, "ok", { label: "Undo", run: undoLastAction });
  setRestartRequired(true);
  artVersion = Date.now();
  await refreshGames();
  setTimeout(() => setProgressState({ visible: false }), 700);
}

async function setVrFromMenu(games, isVr) {
  const targets = Array.isArray(games) ? games : [];
  const changes = [];
  for (const game of targets) {
    const previousIsVr = Boolean(game.isVr);
    const response = await window.steamDrop.setGameVr(game.shortcutId, isVr);
    if (!response.ok) {
      log(`ERROR: ${response.error || `Could not update VR status for ${getDisplayName(game.appName)}.`}`);
      continue;
    }

    game.isVr = isVr;
    for (const item of allGamesCache) {
      if (Number(item.shortcutId) === Number(game.shortcutId)) {
        item.isVr = isVr;
        break;
      }
    }

    if (previousIsVr !== isVr) {
      changes.push({
        shortcutId: Number(game.shortcutId),
        appName: getDisplayName(game.appName),
        previousIsVr
      });
    }
  }

  if (changes.length > 0) {
    pushUndoAction({
      type: "set_vr",
      label: `set VR (${changes.length})`,
      changes
    });
  }

  // Keep the menu open so the switch animation is visible; just refresh the cards behind it.
  const keep = menuTarget;
  flip(renderSortedGames);
  if (keep) {
    menuTarget = keep;
    gameMenu.classList.add("open");
  }
  setRestartRequired(true);
  log(`${targets.length} app(s) marked as ${isVr ? "VR" : "non-VR"} in Steam.`);
}

// ---------- Modals ----------
// Builds an animated dialog. close(value) resolves `closed` with value (null for cancel/Esc/backdrop).
function openModal({ title, subtitle = "", body = "", actions = "", size = "" }) {
  const root = document.createElement("div");
  root.className = "modal";
  root.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-panel ${size}" role="dialog" aria-modal="true">
      <header class="modal-head">
        <div><h2></h2><p></p></div>
        <button type="button" class="btn ghost icon-only sm" data-close aria-label="Close">${icon("x")}</button>
      </header>
      ${body ? `<div class="modal-body">${body}</div>` : ""}
      ${actions ? `<footer class="modal-actions">${actions}</footer>` : ""}
    </div>
  `;
  root.querySelector("h2").textContent = title;
  const sub = root.querySelector(".modal-head p");
  sub.textContent = subtitle;
  sub.hidden = !subtitle;
  root.querySelector(".modal-panel").setAttribute("aria-label", title);

  const previousFocus = document.activeElement;
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  let done = false;

  const onKey = (event) => {
    if (event.key === "Escape" && openModals[openModals.length - 1] === root) {
      event.preventDefault();
      close(null);
    }
  };
  const close = (value = null) => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey);
    openModals.splice(openModals.indexOf(root), 1);
    root.classList.add("closing");
    setTimeout(() => root.remove(), reduceMotion.matches ? 0 : 200);
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    resolveClosed(value);
  };

  root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => close(null)));
  document.addEventListener("keydown", onKey);
  hideGameMenu();
  document.body.appendChild(root);
  openModals.push(root);

  const focusTarget =
    root.querySelector("[autofocus]") ||
    root.querySelector(".modal-body input") ||
    root.querySelector(".modal-actions .btn:last-child");
  requestAnimationFrame(() => focusTarget?.focus());

  return { root, close, closed, find: (selector) => root.querySelector(selector) };
}

async function confirmDialog({ title, message, confirmLabel = "OK", danger = false }) {
  const modal = openModal({
    title,
    subtitle: message,
    actions: `
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn ${danger ? "danger" : "primary"}" data-role="ok"></button>
    `
  });
  const ok = modal.find('[data-role="ok"]');
  ok.textContent = confirmLabel;
  ok.addEventListener("click", () => modal.close(true));
  return (await modal.closed) === true;
}

async function showRenameDialog(currentName, storedPath) {
  const modal = openModal({
    title: "Rename game",
    subtitle: "Steam shows this name in your library.",
    body: `
      <label class="field"><span class="label">Name</span><input class="input" data-role="input" maxlength="120" /></label>
      <div class="field"><span class="label">Executable</span><div class="code-path" data-role="path"></div></div>
    `,
    actions: `
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn primary" data-role="save">Save</button>
    `
  });
  const input = modal.find('[data-role="input"]');
  input.value = currentName;
  modal.find('[data-role="path"]').textContent = storedPath ? String(storedPath) : "Unknown";
  const save = () => modal.close(input.value);
  modal.find('[data-role="save"]').addEventListener("click", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  requestAnimationFrame(() => input.select());
  return modal.closed;
}

async function showApiKeyDialog({ initialApiKey = "", firstRun = false } = {}) {
  const modal = openModal({
    title: "SteamGridDB API key",
    subtitle: "Optional. Adds SteamGridDB artwork when Steam has none, and many more choices in Change art.",
    body: `
      <input class="input" type="password" data-role="input" placeholder="Paste your API key" autocomplete="off" spellcheck="false" />
      <p class="note">Get a free key at
        <a href="https://www.steamgriddb.com/profile/preferences/api" target="_blank" rel="noopener noreferrer">steamgriddb.com/profile/preferences/api</a>
      </p>
    `,
    actions: `
      <button type="button" class="btn ghost" data-close>${firstRun ? "Skip" : "Cancel"}</button>
      <button type="button" class="btn primary" data-role="save">Save</button>
    `
  });
  const input = modal.find('[data-role="input"]');
  const saveButton = modal.find('[data-role="save"]');
  input.value = initialApiKey;

  const save = () =>
    withBusy(saveButton, async () => {
      const response = await window.steamDrop.saveApiKey(String(input.value || "").trim());
      if (!response || !response.ok) {
        log(`ERROR: ${response?.error || "Could not save API key."}`);
        return;
      }

      log(response.hasApiKey ? "SteamGridDB API key saved." : "SteamGridDB API key cleared.");
      toast(response.hasApiKey ? "SteamGridDB key saved" : "SteamGridDB key cleared");
      setApiKeyStatus(response.hasApiKey);
      modal.close(true);
    });
  saveButton.addEventListener("click", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });

  const saved = await modal.closed;
  if (!saved && firstRun) {
    await window.steamDrop.dismissApiKeyPrompt();
  }
  return Boolean(saved);
}

async function ensureApiKeyPromptOnFirstRun() {
  const response = await window.steamDrop.getApiSettings();
  if (!response || !response.ok) {
    return;
  }

  setApiKeyStatus(response.hasApiKey);
  if (!response.hasApiKey && !response.hasSeenPrompt) {
    await showApiKeyDialog({ firstRun: true });
  }
}

function setApiKeyStatus(hasApiKey) {
  apiKeyStatus.classList.toggle("is-set", Boolean(hasApiKey));
  apiKeyBtn.title = hasApiKey ? "SteamGridDB key is set" : "SteamGridDB key not set (optional)";
}

async function refreshApiKeyStatus() {
  const response = await window.steamDrop.getApiSettings();
  if (response && response.ok) {
    setApiKeyStatus(response.hasApiKey);
  }
}

async function refreshSteamInstallLocationStatus() {
  const response = await window.steamDrop.getSteamInstallLocation();
  if (!response || !response.ok) {
    return;
  }

  const steamPath = String(response.steamInstallPath || "").trim();
  steamLocationBtn.title = steamPath ? `Steam location: ${steamPath}` : "Choose Steam install location";
}

// ---------- Art picker ----------
const ART_KINDS = [
  { kind: "portrait", label: "Cover" },
  { kind: "landscape", label: "Wide" },
  { kind: "hero", label: "Hero" },
  { kind: "logo", label: "Logo" }
];

async function showArtDialog(game) {
  const name = getDisplayName(game.appName);
  const modal = openModal({
    title: "Change art",
    subtitle: name,
    size: "wide",
    body: `
      <div class="seg" data-role="tabs">
        <span class="seg-indicator"></span>
        ${ART_KINDS.map((k) => `<button type="button" data-kind="${k.kind}">${k.label}</button>`).join("")}
      </div>
      <div class="art-grid" data-role="grid"></div>
    `,
    actions: `
      <button type="button" class="btn ghost" data-role="file">${icon("file")}From file...</button>
      <span class="spacer"></span>
      <button type="button" class="btn primary" data-close>Done</button>
    `
  });
  const tabs = modal.find('[data-role="tabs"]');
  const indicator = tabs.querySelector(".seg-indicator");
  const grid = modal.find('[data-role="grid"]');
  let kind = "portrait";
  let options = null;
  let loadError = "";
  let hasApiKey = true;
  let changed = false;
  const chosen = {};

  const apply = async (source) => {
    const response = await window.steamDrop.setArt({ shortcutId: game.shortcutId, kind, ...source });
    if (!response.ok) {
      log(`ERROR: ${response.error || "Could not set art."}`);
      return false;
    }
    changed = true;
    chosen[kind] = source.url || null;
    log(`Updated ${kind} art for ${name}.`);
    toast(`${ART_KINDS.find((k) => k.kind === kind).label} art updated`);
    grid.querySelectorAll(".art-option.chosen").forEach((el) => el.classList.remove("chosen"));
    return true;
  };

  const renderKind = () => {
    for (const button of tabs.querySelectorAll("button")) {
      const active = button.dataset.kind === kind;
      button.classList.toggle("active", active);
      if (active) {
        indicator.style.setProperty("--x", `${button.offsetLeft}px`);
        indicator.style.setProperty("--w", `${button.offsetWidth}px`);
      }
    }
    grid.dataset.kind = kind;

    if (!options && !loadError) {
      grid.innerHTML = '<div class="skeleton"></div>'.repeat(8);
      return;
    }
    const list = options?.[kind] || [];
    if (list.length === 0) {
      const empty = document.createElement("p");
      empty.className = "art-empty";
      empty.textContent =
        loadError ||
        `No online results for this art type. Use "From file..."${hasApiKey ? "" : ", or add a SteamGridDB key for more choices"}.`;
      grid.replaceChildren(empty);
      return;
    }

    grid.replaceChildren(
      ...list.map((option, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "art-option";
        button.classList.toggle("chosen", chosen[kind] === option.url);
        button.style.setProperty("--delay", `${Math.min(index, 16) * 25}ms`);
        button.innerHTML = `<span class="check">${icon("check")}</span><span class="src"></span>`;
        button.querySelector(".src").textContent = option.source;
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = option.source;
        img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
        img.src = option.thumb;
        button.prepend(img);
        button.addEventListener("click", async () => {
          if (button.querySelector(".busy")) return;
          const busy = document.createElement("div");
          busy.className = "busy";
          busy.innerHTML = '<span class="spinner"></span>';
          button.appendChild(busy);
          const ok = await apply({ url: option.url });
          busy.remove();
          if (ok) button.classList.add("chosen");
        });
        return button;
      })
    );
  };

  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button || button.dataset.kind === kind) return;
    kind = button.dataset.kind;
    renderKind();
  });
  const fileButton = modal.find('[data-role="file"]');
  fileButton.addEventListener("click", () =>
    withBusy(fileButton, async () => {
      const filePath = await window.steamDrop.pickArtFile();
      if (filePath) await apply({ filePath });
    })
  );

  requestAnimationFrame(renderKind);
  window.steamDrop.listArtOptions(game.shortcutId).then((response) => {
    if (!response.ok) {
      loadError = response.error || "Could not load art options.";
      log(`ERROR: ${loadError}`);
    } else {
      options = response.options;
      hasApiKey = response.hasApiKey !== false;
    }
    renderKind();
  });

  await modal.closed;
  if (changed) {
    artVersion = Date.now();
    setRestartRequired(true);
    await refreshGames();
  }
}

// ---------- Cloud saves ----------
// Turns cloud saves on for each game. auto = no dialogs: use the cloud's or the detected save folder,
// and skip games whose save location is unknown.
async function enableSyncFor(games, { auto, onStep = () => {} }) {
  const result = { on: [], skipped: [], failed: 0 };
  for (const [index, game] of games.entries()) {
    const name = getDisplayName(game.appName);
    const response = await window.steamDrop.enableSync(game.shortcutId, auto);
    onStep(index + 1);
    if (!response.ok) {
      log(`ERROR: ${name}: ${response.error || "Could not turn on cloud saves."}`);
      result.failed += 1;
      continue;
    }
    if (response.canceled || response.alreadyOn) continue;
    if (response.skipped) {
      result.skipped.push(name);
      log(`Cloud saves not turned on for ${name}: ${response.skipped}`);
      continue;
    }
    result.on.push(name);
    log(
      response.fromCloud
        ? `Cloud saves on for ${name}, using the save folder set up on ${response.cloudDevice || "another device"}.`
        : `Cloud saves on for ${name}.`
    );
    log(`  Cloud key: ${response.key} (give the game the same name on your other devices)`);
    log(`  Save folder: ${response.resolvedPath}`);
  }
  return result;
}

function reportSyncResult({ on, skipped }) {
  const names = (list) => (list.length === 1 ? list[0] : plural(list.length, "game"));
  if (on.length > 0) toast(`Cloud saves on for ${names(on)}`);
  if (skipped.length > 0) {
    toast(
      `Couldn't find where ${skipped.length === 1 ? skipped[0] : `${skipped.length} games`} save${skipped.length === 1 ? "s" : ""}. ` +
        "Right-click to turn cloud saves on and pick the folder.",
      "info"
    );
  }
}

async function isCloudConnected() {
  const settings = await window.steamDrop.getCloudSettings().catch(() => null);
  return Boolean(settings?.rcloneRemote);
}

// One game: the interactive flow (confirm or pick the folder). Several: batch, no dialogs.
// If every selected game is synced this turns them all off; otherwise it turns on the rest.
async function setSyncFromMenu(games) {
  if (games.every((game) => game.syncEnabled)) {
    let off = 0;
    for (const game of games) {
      const response = await window.steamDrop.disableSync(game.shortcutId);
      if (!response.ok) {
        log(`ERROR: ${getDisplayName(game.appName)}: ${response.error || "Could not turn off cloud saves."}`);
        continue;
      }
      off += 1;
      log(`Cloud saves off for ${getDisplayName(game.appName)}. Cloud copies are left untouched.`);
    }
    if (off > 0) toast(`Cloud saves off for ${off === 1 ? getDisplayName(games[0].appName) : plural(off, "game")}`, "info");
  } else {
    if (!(await isCloudConnected())) {
      toast("Connect a cloud account first", "err", { label: "Set up", run: showCloudDialog });
      return;
    }
    const targets = games.filter((game) => !game.syncEnabled);
    const batch = targets.length > 1;
    const label = "Turning on cloud saves";
    if (batch) setProgressState({ visible: true, label, done: 0, total: targets.length });
    const result = await enableSyncFor(targets, {
      auto: batch,
      onStep: (done) => batch && setProgressState({ visible: true, label, done, total: targets.length })
    });
    reportSyncResult(result);
    if (batch) setTimeout(() => setProgressState({ visible: false }), 700);
    if (result.on.length === 0) return;
  }
  setRestartRequired(true);
  await refreshGames();
}

async function showCloudDialog() {
  const current = await window.steamDrop.getCloudSettings();
  const modal = openModal({
    title: "Cloud saves",
    subtitle: "Your saves follow you between this PC, your Steam Deck and any other linked device.",
    size: "medium",
    body: `
      <section class="section">
        <span class="label">Cloud account</span>
        <p class="note">Connect the same account on every device you play on. Your browser opens to log in.</p>
        <div class="inline-row">
          <button type="button" class="btn ghost" data-provider="drive">${icon("cloud")}Google Drive</button>
          <button type="button" class="btn ghost" data-provider="onedrive">${icon("cloud")}OneDrive</button>
          <button type="button" class="btn ghost" data-provider="dropbox">${icon("cloud")}Dropbox</button>
        </div>
        <label class="field">
          <span class="label">Remote (advanced)</span>
          <span class="inline-row">
            <input class="input" type="text" data-role="remote" placeholder="Not connected" spellcheck="false" />
            <button type="button" class="btn ghost" data-role="test">${icon("refresh")}Test</button>
          </span>
        </label>
        <p class="status-line" data-role="status"></p>
      </section>
      <section class="section">
        <span class="label">This device</span>
        <div class="inline-row">
          <input class="input" type="text" data-role="device-name" maxlength="60" spellcheck="false" />
          <button type="button" class="btn ghost" data-role="rename-device">${icon("edit")}Rename</button>
        </div>
      </section>
      <section class="section">
        <span class="label">Linked devices</span>
        <div class="list" data-role="devices"></div>
      </section>
      <section class="section">
        <span class="label">Synced games</span>
        <div class="list" data-role="games"></div>
      </section>
      <section class="section">
        <span class="label">Steam Deck Game Mode</span>
        <p class="note">Saves already sync in Game Mode, because they run through each game's Steam shortcut. Add this app to Steam to open it from Game Mode too.</p>
        <div><button type="button" class="btn ghost" data-role="add-self">${icon("gamepad")}Add this app to Steam</button></div>
      </section>
    `,
    actions: `
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn primary" data-role="save">Save</button>
    `
  });
  const remote = modal.find('[data-role="remote"]');
  const status = modal.find('[data-role="status"]');
  const deviceName = modal.find('[data-role="device-name"]');
  const devicesBox = modal.find('[data-role="devices"]');
  const gamesBox = modal.find('[data-role="games"]');
  remote.value = current.rcloneRemote || "";
  const values = () => ({ rcloneRemote: remote.value.trim() });

  const setStatus = (text, kind = "") => {
    status.className = `status-line ${kind}`;
    status.textContent = "";
    void status.offsetWidth;
    status.textContent = text;
  };
  const listMessage = (box, text) => {
    const el = document.createElement("div");
    el.className = "list-empty";
    el.textContent = text;
    box.replaceChildren(el);
  };
  const row = ({ title, sub, iconName, tag, action, index }) => {
    const el = document.createElement("div");
    el.className = "row";
    el.style.setProperty("--i", index);
    el.innerHTML = `<span class="row-icon">${icon(iconName)}</span><div class="row-text"><strong></strong><span></span></div>`;
    const strong = el.querySelector("strong");
    strong.textContent = title;
    if (tag) {
      const pill = document.createElement("em");
      pill.className = "pill";
      pill.textContent = tag;
      strong.appendChild(pill);
    }
    el.querySelector(".row-text > span").textContent = sub;
    if (action) el.appendChild(action);
    return el;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");
  const osName = (p) => (p === "win32" ? "Windows" : p === "linux" ? "Linux / Steam Deck" : p || "Unknown OS");

  const loadOverview = async () => {
    const skeleton = '<div class="skeleton row-skeleton"></div>'.repeat(2);
    devicesBox.innerHTML = skeleton;
    gamesBox.innerHTML = skeleton;
    const data = await window.steamDrop.getCloudOverview();
    if (!data.ok) {
      listMessage(devicesBox, `Could not load devices: ${data.error}`);
      gamesBox.replaceChildren();
      return;
    }
    deviceName.value = data.deviceName || "";
    if (!data.connected) {
      listMessage(devicesBox, "Connect a cloud account to link devices.");
      listMessage(gamesBox, "Turn on cloud saves for a game by right-clicking it.");
      return;
    }

    const devices = [...data.devices].sort((a, b) => (a.id === data.thisDeviceId ? -1 : b.id === data.thisDeviceId ? 1 : 0));
    const namesById = new Map(devices.map((d) => [d.id, d.name]));
    devicesBox.replaceChildren(
      ...devices.map((device, index) => {
        const isThis = device.id === data.thisDeviceId;
        let forget = null;
        if (!isThis) {
          forget = document.createElement("button");
          forget.type = "button";
          forget.className = "btn ghost danger sm";
          forget.textContent = "Forget";
          forget.title = "Remove from this list (its saves stay in the cloud)";
          forget.addEventListener("click", () =>
            withBusy(forget, async () => {
              const response = await window.steamDrop.forgetDevice(device.id);
              if (!response.ok) log(`ERROR: ${response.error}`);
              await loadOverview();
            })
          );
        }
        const count = (device.games || []).length;
        return row({
          title: device.name,
          tag: isThis ? "This device" : "",
          sub: `${osName(device.platform)} · ${plural(count, "synced game")} · last seen ${when(device.lastSeen)}`,
          iconName: device.platform === "linux" ? "gamepad" : "monitor",
          action: forget,
          index
        });
      })
    );
    if (devices.length === 0) listMessage(devicesBox, "No devices yet. This device appears after its first sync.");

    const games = [...data.games].sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key)));
    if (games.length === 0) {
      listMessage(gamesBox, "No saves uploaded yet. Right-click a game and turn on cloud saves.");
      return;
    }
    gamesBox.replaceChildren(
      ...games.map((game, index) => {
        const sharedBy = devices.filter((d) => (d.games || []).some((g) => g.key === game.key)).map((d) => d.name);
        const lastBy = namesById.get(game.deviceId) || game.device || "unknown device";
        return row({
          title: game.name || game.key,
          sub: `On ${sharedBy.join(", ") || "no linked device"} · last upload from ${lastBy}, ${when(game.updatedAt)}`,
          iconName: "cloud",
          index
        });
      })
    );
  };

  const renameButton = modal.find('[data-role="rename-device"]');
  renameButton.addEventListener("click", () =>
    withBusy(renameButton, async () => {
      const response = await window.steamDrop.renameDevice(deviceName.value);
      if (!response.ok) {
        setStatus(`Error: ${response.error}`, "err");
        return;
      }
      toast("Device renamed");
      await loadOverview();
    })
  );

  const addSelfButton = modal.find('[data-role="add-self"]');
  addSelfButton.addEventListener("click", () =>
    withBusy(addSelfButton, async () => {
      const response = await window.steamDrop.addSelfToSteam();
      if (!response.ok) {
        setStatus(`Error: ${response.error}`, "err");
        return;
      }
      setStatus("Added. Restart Steam to see Non-Steam Uploader in your library.", "ok");
      setRestartRequired(true);
    })
  );

  modal.root.querySelectorAll("[data-provider]").forEach((button) =>
    button.addEventListener("click", () =>
      withBusy(button, async () => {
        setStatus("Waiting for you to log in in the browser...");
        const response = await window.steamDrop.connectCloud({ type: button.dataset.provider });
        if (!response.ok) {
          setStatus(`Error: ${response.error}`, "err");
          return;
        }
        setStatus("Connected.", "ok");
        remote.value = response.rcloneRemote;
        await loadOverview();
      })
    )
  );

  const testButton = modal.find('[data-role="test"]');
  testButton.addEventListener("click", () =>
    withBusy(testButton, async () => {
      setStatus("Testing...");
      const response = await window.steamDrop.testCloud(values());
      setStatus(response.ok ? "Cloud reachable." : `Error: ${response.error}`, response.ok ? "ok" : "err");
    })
  );

  const saveButton = modal.find('[data-role="save"]');
  saveButton.addEventListener("click", () =>
    withBusy(saveButton, async () => {
      const response = await window.steamDrop.saveCloudSettings(values());
      if (!response.ok) {
        setStatus(`Error: ${response.error}`, "err");
        return;
      }
      log(values().rcloneRemote ? `Cloud saves use remote ${values().rcloneRemote}` : "Cloud saves disabled (no remote).");
      toast(values().rcloneRemote ? "Cloud settings saved" : "Cloud saves turned off", values().rcloneRemote ? "ok" : "info");
      modal.close(true);
    })
  );

  loadOverview();
  await modal.closed;
}

cloudBtn.addEventListener("click", showCloudDialog);

function isSupportedGameFile(filePath) {
  if (!filePath) {
    return false;
  }
  const normalized = String(filePath).toLowerCase();
  return normalized.endsWith(".exe") || normalized.endsWith(".lnk");
}

// ---------- Global interactions ----------
document.addEventListener("click", (event) => {
  if (gameMenu.classList.contains("open") && !gameMenu.contains(event.target)) {
    hideGameMenu();
  }
});

gamesGrid.addEventListener("click", (event) => {
  if (event.target === gamesGrid && selectedShortcutIds.size > 0) {
    clearSelection();
  }
});

document.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".game-card")) {
    hideGameMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (openModals.length > 0 || event.target.closest?.("input, select, textarea")) return;
  const mod = event.ctrlKey || event.metaKey;

  if (event.key === "Escape") {
    if (gameMenu.classList.contains("open")) hideGameMenu();
    else clearSelection();
  } else if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoLastAction();
  } else if (mod && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectedShortcutIds = new Set(currentGames.map((game) => Number(game.shortcutId)));
    updateSelectionUI();
  } else if (event.key === "Delete" && selectedShortcutIds.size > 0) {
    event.preventDefault();
    hideGameMenu();
    removeGamesFromMenu(getSelectedGames());
  }
});

window.addEventListener("blur", hideGameMenu);
window.addEventListener("resize", hideGameMenu);
document.addEventListener("scroll", hideGameMenu, true);

activityBtn.addEventListener("click", () => {
  const open = activityBtn.parentElement.classList.toggle("open");
  activityBtn.setAttribute("aria-expanded", String(open));
  if (open) statusLog.scrollTop = statusLog.scrollHeight;
});

sortSelect.addEventListener("change", () => flip(renderSortedGames));

const savedSize = localStorage.getItem(GRID_SIZE_STORAGE_KEY);
if (savedSize === "small" || savedSize === "medium" || savedSize === "large") {
  sizeSelect.value = savedSize;
}
sizeSelect.addEventListener("change", () => {
  localStorage.setItem(GRID_SIZE_STORAGE_KEY, sizeSelect.value);
  flip(applyGridSize);
});

apiKeyBtn.addEventListener("click", async () => {
  const response = await window.steamDrop.getApiSettings();
  if (!response || !response.ok) {
    log(`ERROR: ${response?.error || "Could not load API key settings."}`);
    return;
  }

  await showApiKeyDialog({ initialApiKey: response.apiKey || "" });
  await refreshApiKeyStatus();
});

steamLocationBtn.addEventListener("click", async () => {
  const response = await window.steamDrop.pickSteamInstallLocation();
  if (!response || !response.ok) {
    log(`ERROR: ${response?.error || "Could not set Steam install location."}`);
    return;
  }

  if (response.canceled) {
    return;
  }

  log(`Steam install location set to: ${response.steamInstallPath}`);
  toast("Steam location updated");
  await refreshSteamInstallLocationStatus();
  await refreshGames();
});

Promise.resolve()
  .then(() => refreshGames())
  .then(() => refreshApiKeyStatus())
  .then(() => refreshSteamInstallLocationStatus())
  .then(() => ensureApiKeyPromptOnFirstRun());

updateUndoButton();
