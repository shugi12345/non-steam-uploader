const fs = require("fs/promises");
const path = require("path");

async function fetchArtworkPack({ title, sourceUrl, apiKey }) {
  const notes = [];

  const steamInfo = await resolveSteamCandidate(title, sourceUrl);
  if (steamInfo) {
    const official = await getOfficialSteamArtwork(steamInfo.appId);
    if (official.anyFound) {
      notes.push(`Official Steam artwork from app ${steamInfo.appId}.`);
      return {
        source: `Steam (${steamInfo.appId})`,
        notes,
        assets: official.assets
      };
    }
    notes.push(`Steam app ${steamInfo.appId} found, but artwork variants were incomplete.`);
  } else {
    notes.push("No Steam app match found for official artwork.");
  }

  const sgdbKey = String(apiKey || process.env.STEAMGRIDDB_API_KEY || "").trim();
  if (!sgdbKey) {
    notes.push("STEAMGRIDDB_API_KEY is not set, fallback skipped.");
    return {
      source: "none",
      notes,
      assets: {}
    };
  }

  const fallback = await getSteamGridDbArtwork(title, sgdbKey);
  if (!fallback.anyFound) {
    notes.push("SteamGridDB fallback did not return usable images.");
    return {
      source: "none",
      notes,
      assets: {}
    };
  }

  notes.push(`SteamGridDB fallback used (gameId=${fallback.gameId}).`);
  return {
    source: "SteamGridDB",
    notes,
    assets: fallback.assets
  };
}

async function saveArtworkPack({ gridDir, shortcutId, artwork }) {
  await fs.mkdir(gridDir, { recursive: true });

  const naming = {
    landscape: `${shortcutId}.jpg`,
    portrait: `${shortcutId}p.jpg`,
    hero: `${shortcutId}_hero.jpg`,
    logo: `${shortcutId}_logo.png`
  };

  const saved = [];

  for (const [kind, asset] of Object.entries(artwork.assets || {})) {
    if (!asset || !asset.url || !naming[kind]) {
      continue;
    }

    try {
      const buffer = await downloadBinary(asset.url);
      const filePath = path.join(gridDir, naming[kind]);
      await fs.writeFile(filePath, buffer);
      saved.push(filePath);
    } catch {
      // Continue when one image fails; partial artwork is still useful.
    }
  }

  return saved;
}

async function resolveSteamCandidate(title, sourceUrl) {
  const byUrl = parseSteamAppIdFromUrl(sourceUrl);
  if (byUrl) {
    return { appId: byUrl, reason: "url" };
  }

  const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
    title
  )}&l=english&cc=US`;

  const res = await fetch(searchUrl);
  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0 || !items[0].id) {
    return null;
  }

  return { appId: items[0].id, reason: "search" };
}

async function getOfficialSteamArtwork(appId) {
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}`;
  const candidates = {
    landscape: [`${base}/library_capsule.jpg`, `${base}/header.jpg`],
    portrait: [`${base}/library_600x900.jpg`],
    hero: [`${base}/library_hero.jpg`],
    logo: [`${base}/logo.png`]
  };

  const assets = {};

  for (const [kind, urls] of Object.entries(candidates)) {
    for (const url of urls) {
      if (await isReachable(url)) {
        assets[kind] = { url };
        break;
      }
    }
  }

  return {
    anyFound: Object.keys(assets).length > 0,
    assets
  };
}

async function getSteamGridDbArtwork(title, apiKey) {
  const encodedTitle = encodeURIComponent(title);
  const search = await sgdbRequest(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodedTitle}`, apiKey);
  const match = Array.isArray(search?.data) ? search.data[0] : null;
  if (!match || !match.id) {
    return { anyFound: false, assets: {} };
  }

  const gameId = match.id;
  const [gridsPortrait, gridsLandscape, heroes, logos] = await Promise.all([
    sgdbRequest(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900`, apiKey),
    sgdbRequest(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=460x215`, apiKey),
    sgdbRequest(`https://www.steamgriddb.com/api/v2/heroes/game/${gameId}`, apiKey),
    sgdbRequest(`https://www.steamgriddb.com/api/v2/logos/game/${gameId}`, apiKey)
  ]);

  const pick = (packet) => (Array.isArray(packet?.data) && packet.data.length > 0 ? packet.data[0] : null);

  const portrait = pick(gridsPortrait);
  const landscape = pick(gridsLandscape);
  const hero = pick(heroes);
  const logo = pick(logos);

  const assets = {};
  if (landscape?.url) assets.landscape = { url: landscape.url };
  if (portrait?.url) assets.portrait = { url: portrait.url };
  if (hero?.url) assets.hero = { url: hero.url };
  if (logo?.url) assets.logo = { url: logo.url };

  return {
    anyFound: Object.keys(assets).length > 0,
    gameId,
    assets
  };
}

async function sgdbRequest(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

function parseSteamAppIdFromUrl(sourceUrl) {
  if (!sourceUrl) {
    return null;
  }

  try {
    const url = new URL(sourceUrl);
    const match = url.pathname.match(/\/app\/(\d+)/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
    return null;
  } catch {
    return null;
  }
}

async function isReachable(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function downloadBinary(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  fetchArtworkPack,
  saveArtworkPack
};
