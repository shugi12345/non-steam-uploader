const fs = require("fs/promises");
const path = require("path");
const {
  addShortcutForInput,
  listManagedShortcuts,
  removeManagedShortcut,
  renameManagedShortcut,
  setManagedShortcutVr,
  removeAllManagedShortcuts
} = require("./steamShortcuts");
const { fetchArtworkPack, saveArtworkPack } = require("./artwork");

async function processInput(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid request payload.");
  }

  const { kind, value } = payload;
  if ((kind !== "exe" && kind !== "file") || typeof value !== "string") {
    throw new Error("Unsupported item. Use an .exe or .lnk file.");
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Input is empty.");
  }

  const shortcutResult = await addShortcutForInput({ kind, value: normalized });

  const artwork = await fetchArtworkPack({
    title: shortcutResult.appName,
    sourceUrl: undefined,
    apiKey: options.apiKey
  });

  const savedFiles = await saveArtworkPack({
    gridDir: shortcutResult.gridDir,
    shortcutId: shortcutResult.shortcutId,
    artwork
  });

  return {
    ok: true,
    result: {
      appName: shortcutResult.appName,
      userId: shortcutResult.userId,
      shortcutId: shortcutResult.shortcutId,
      gridDir: shortcutResult.gridDir,
      artworkSource: artwork.source,
      savedArtwork: savedFiles,
      notes: artwork.notes
    }
  };
}

async function getGames() {
  const items = await listManagedShortcuts();
  const enriched = await Promise.all(
    items.map(async (item) => {
      const coverPath = await pickFirstExisting([
        path.join(item.gridDir, `${item.shortcutId}p.jpg`),
        path.join(item.gridDir, `${item.shortcutId}.jpg`)
      ]);

      return {
        appName: item.appName,
        shortcutId: item.shortcutId,
        exePath: item.exePath || "",
        isVr: Boolean(item.isVr),
        coverPath,
        userId: item.userId
      };
    })
  );

  return {
    ok: true,
    games: enriched
  };
}

async function removeGame(shortcutId) {
  const removed = await removeManagedShortcut(shortcutId);
  if (!removed) {
    return {
      ok: false,
      error: "Game not found in managed list."
    };
  }

  await deleteArtworkSet(removed.gridDir, removed.shortcutId);

  return {
    ok: true,
    removed
  };
}

async function removeAllGames() {
  const removed = await removeAllManagedShortcuts();

  await Promise.all(
    removed.map((item) => deleteArtworkSet(item.gridDir, item.shortcutId))
  );

  return {
    ok: true,
    removedCount: removed.length
  };
}

async function renameGame(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid rename request.");
  }

  const shortcutId = payload.shortcutId;
  const nextName = String(payload.appName || "").trim();
  if (!nextName) {
    throw new Error("App name cannot be empty.");
  }

  const renamed = await renameManagedShortcut(shortcutId, nextName);
  if (!renamed) {
    return {
      ok: false,
      error: "Game not found in managed list."
    };
  }

  const artwork = await fetchArtworkPack({
    title: renamed.appName,
    sourceUrl: undefined,
    apiKey: options.apiKey
  });

  const savedFiles = await saveArtworkPack({
    gridDir: renamed.gridDir,
    shortcutId: renamed.shortcutId,
    artwork
  });

  if (renamed.previousShortcutId !== renamed.shortcutId) {
    await deleteArtworkSet(renamed.gridDir, renamed.previousShortcutId);
  }

  return {
    ok: true,
    result: {
      appName: renamed.appName,
      previousAppName: renamed.previousAppName,
      shortcutId: renamed.shortcutId,
      previousShortcutId: renamed.previousShortcutId,
      userId: renamed.userId,
      gridDir: renamed.gridDir,
      artworkSource: artwork.source,
      savedArtwork: savedFiles,
      notes: artwork.notes
    }
  };
}

async function setGameVr(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid VR update request.");
  }

  const updated = await setManagedShortcutVr(payload.shortcutId, payload.isVr);
  if (!updated) {
    return {
      ok: false,
      error: "Game not found in managed list."
    };
  }

  return {
    ok: true,
    result: updated
  };
}

async function deleteArtworkSet(gridDir, shortcutId) {
  const files = [
    path.join(gridDir, `${shortcutId}.jpg`),
    path.join(gridDir, `${shortcutId}p.jpg`),
    path.join(gridDir, `${shortcutId}_hero.jpg`),
    path.join(gridDir, `${shortcutId}_logo.png`)
  ];

  await Promise.all(
    files.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw error;
        }
      }
    })
  );
}

async function pickFirstExisting(filePaths) {
  for (const filePath of filePaths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Check next candidate.
    }
  }

  return null;
}

module.exports = {
  processInput,
  getGames,
  removeGame,
  renameGame,
  setGameVr,
  removeAllGames
};
