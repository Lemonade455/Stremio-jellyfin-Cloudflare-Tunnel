// ============================================================================
//   Stremio Jellyfin Addon – Clean, Stable & Fully Patched
//   – Correct Series Structure (seasons → episodes → streams)
//   – Correct Streams for Movies + Episodes
//   – TMDB Posters, Backdrops, Ratings
//   – Robust Login & Logging
// ============================================================================

const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");

// --- FIX: Node-fetch works in Docker/Node20 ---
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
global.fetch = fetch;

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// ============================================================================
// ENV
// ============================================================================
const PORT = process.env.PORT || 60421;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JF = (process.env.JELLYFIN_SERVER || "").replace(/\/$/, "");
const JF_USER = process.env.JELLYFIN_USER || "";
const JF_PASS = process.env.JELLYFIN_PASSWORD || "";
const TMDB = process.env.TMDB_API_KEY || "";

// ============================================================================
// STATE
// ============================================================================
let jfToken = null;
let jfUserId = null;

const dataDir = path.join(__dirname, "data");
const tmdbCacheFile = path.join(dataDir, "tmdb-cache.json");

// ============================================================================
// CACHE INIT
// ============================================================================
async function ensureDataDir() {
  try { await fsp.mkdir(dataDir, { recursive: true }); } catch (_) {}

  const st = await fsp.lstat(tmdbCacheFile).catch(() => null);
  if (st?.isDirectory()) {
    await fsp.rm(tmdbCacheFile, { recursive: true, force: true });
  }

  try {
    await fsp.access(tmdbCacheFile).catch(async () => {
      await fsp.writeFile(tmdbCacheFile, "{}", "utf8");
    });
  } catch (_) {}
}

async function readCache() {
  await ensureDataDir();
  try {
    return JSON.parse(await fsp.readFile(tmdbCacheFile, "utf8"));
  } catch {
    await fsp.writeFile(tmdbCacheFile, "{}", "utf8");
    return {};
  }
}

async function writeCache(obj) {
  await ensureDataDir();
  try {
    await fsp.writeFile(tmdbCacheFile, JSON.stringify(obj), "utf8");
  } catch (_) {}
}

// ============================================================================
// HELPERS
// ============================================================================
function ticksToMinutes(t) {
  if (!t || t <= 0) return undefined;
  const sec = Math.round(t / 10000000);
  return Math.max(1, Math.round(sec / 60));
}

function jfHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Emby-Authorization":
      'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="stremio-addon", Version="4.0.0"',
    "X-MediaBrowser-Token": jfToken
  };
}

// ============================================================================
// LOGIN
// ============================================================================
async function jfLogin() {
  console.log(`🔐 Försöker logga in mot ${JF}/Users/AuthenticateByName`);

  const res = await fetch(`${JF}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="stremio-addon", Version="4.0.0"'
    },
    body: JSON.stringify({ Username: JF_USER, Pw: JF_PASS })
  });

  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);
  const j = await res.json();

  jfToken = j.AccessToken;
  jfUserId = j.User?.Id;
  const name = j.User?.Name || JF_USER;

  console.log("-----------------------------------------------------");
  console.log(`✅ Inloggad som: ${name}`);
  console.log(`🔑 User-ID: ${jfUserId}`);
  console.log(`🎦 Jellyfin-server: ${JF}`);
  console.log("-----------------------------------------------------");

  return true;
}

// ============================================================================
// POSTER / BACKDROP HELPERS
// ============================================================================
function jfPosterUrl(it, w = 500) {
  if (!it?.Id || !it.PrimaryImageTag) return null;
  return `${JF}/Items/${it.Id}/Images/Primary?fillWidth=${w}&quality=90&tag=${it.PrimaryImageTag}&api_key=${jfToken}`;
}

function jfBackdropUrl(it, w = 1280) {
  if (!it) return null;
  const tag = it.BackdropImageTags?.[0] || it.PrimaryImageTag;
  if (!tag) return null;
  return `${JF}/Items/${it.Id}/Images/Backdrop?fillWidth=${w}&quality=90&tag=${tag}&api_key=${jfToken}`;
}

// ============================================================================
// TMDB LOOKUP
// ============================================================================
async function tmdbLookup(title, year, isMovie = true) {
  if (!TMDB) return null;

  const cache = await readCache();
  const key = `${isMovie ? "m" : "s"}|${title}|${year || ""}`;

  if (cache[key]) return cache[key];

  const base = "https://api.themoviedb.org/3";
  const path = isMovie ? "/search/movie" : "/search/tv";

  const params = new URLSearchParams({
    api_key: TMDB,
    query: title,
    language: "sv-SE",
    include_adult: "false"
  });

  if (year)
    params.set(isMovie ? "year" : "first_air_date_year", String(year));

  const r = await fetch(`${base}${path}?${params}`);
  const j = await r.json();
  const hit = j.results?.[0];

  if (!hit) return null;

  const img = "https://image.tmdb.org/t/p/original";

  const out = {
    title: hit.title || hit.name || title,
    overview: hit.overview || null,
    poster: hit.poster_path ? `${img}${hit.poster_path}` : null,
    backdrop: hit.backdrop_path ? `${img}${hit.backdrop_path}` : null,
    year: (hit.release_date || hit.first_air_date || "").slice(0, 4) || year,
    imdbRating: typeof hit.vote_average === "number"
      ? Number(hit.vote_average.toFixed(1))
      : null
  };

  cache[key] = out;
  await writeCache(cache);
  return out;
}

// ============================================================================
// STREMIO ADDON
// ============================================================================
const manifest = require("./manifest.json");
const builder = new addonBuilder(manifest);

// ============================================================================
// CATALOG
// ============================================================================
builder.defineCatalogHandler(async ({ type }) => {
  if (!jfToken) await jfLogin();

  console.log(`📁 Laddar katalog för: ${type} …`);

  const include = type === "movie" ? "Movie" : "Series";

  const url =
    `${JF}/Items?IncludeItemTypes=${include}` +
    `&Recursive=true&Fields=PrimaryImageTag,ProductionYear` +
    `&Limit=500&UserId=${jfUserId}`;

  const r = await fetch(url, { headers: jfHeaders() });
  const j = await r.json();
  const items = j.Items || [];

  console.log(`📦 Jellyfin gav ${items.length} objekt för typ "${type}".`);

  const metas = await Promise.all(
    items.map(async it => {
      const t = await tmdbLookup(it.Name, it.ProductionYear, type === "movie");
      const poster = t?.poster || jfPosterUrl(it, 500);
      return {
        id: `jf:${it.Id}`,
        type,
        name: it.Name,
        poster,
        posterShape: "regular"
      };
    })
  );

  return { metas };
});

// ============================================================================
// META (Correct Series → Seasons → Episodes)
// ============================================================================
builder.defineMetaHandler(async ({ type, id }) => {
  if (!jfToken) await jfLogin();

  console.log(`🧩 Hämtar metadata för ${type}: ${id}`);

  const jfId = id.replace(/^jf:/, "");

  const metaUrl =
    `${JF}/Items/${jfId}` +
    `?Fields=PrimaryImageTag,Overview,Genres,ProductionYear,BackdropImageTags,RunTimeTicks` +
    `&UserId=${jfUserId}`;

  const r = await fetch(metaUrl, { headers: jfHeaders() });
  const it = await r.json();

  console.log(`🔍 Meta från Jellyfin: ${it.Name} (${it.ProductionYear || "?"})`);

  if (type === "movie") {
    const t = await tmdbLookup(it.Name, it.ProductionYear, true);
    return {
      meta: {
        id,
        type,
        name: it.Name,
        poster: t?.poster || jfPosterUrl(it, 700),
        background: t?.backdrop || jfBackdropUrl(it, 1920),
        description: t?.overview || it.Overview,
        releaseInfo: String(it.ProductionYear),
        runtime: ticksToMinutes(it.RunTimeTicks),
        genres: it.Genres,
        imdbRating: t?.imdbRating || "N/A"
      }
    };
  }

  // SERIES
  const epsUrl =
    `${JF}/Items?ParentId=${jfId}` +
    `&IncludeItemTypes=Episode&Recursive=true` +
    `&Fields=ParentIndexNumber,IndexNumber,PremiereDate,PrimaryImageTag` +
    `&UserId=${jfUserId}`;

  const re = await fetch(epsUrl, { headers: jfHeaders() });
  const ej = await re.json();
  const eps = ej.Items || [];

  console.log(`📺 Serie: "${it.Name}" – Laddade ${eps.length} avsnitt totalt`);

  const videos = eps
    .map(ep => ({
      id: `jf:${jfId}:${ep.ParentIndexNumber}:${ep.IndexNumber}:${ep.Id}`,
      title: ep.Name,
      season: ep.ParentIndexNumber,
      episode: ep.IndexNumber,
      released: ep.PremiereDate,
      thumbnail: jfPosterUrl(ep, 350)
    }))
    .sort((a, b) =>
      a.season === b.season
        ? a.episode - b.episode
        : a.season - b.season
    );

  return {
    meta: {
      id,
      type: "series",
      name: it.Name,
      poster: jfPosterUrl(it, 700),
      background: jfBackdropUrl(it, 1920),
      description: it.Overview,
      videos
    }
  };
});

// ============================================================================
// STREAM HANDLER
// ============================================================================
builder.defineStreamHandler(async ({ id, type }) => {
  if (!jfToken) await jfLogin();

  console.log(`🎞️ Stream-request: ${id} (${type})`);

  const parts = id.split(":");

  if (type === "movie") {
    const jfId = parts[1];
    return {
      streams: [{
        name: "Direct Stream",
        title: "Direktström (Film)",
        url: `${JF}/Videos/${jfId}/stream?static=true&api_key=${jfToken}`
      }]
    };
  }

  // SERIES EPISODE STREAM
  const epId = parts[4];
  if (!epId) return { streams: [] };

  return {
    streams: [{
      name: "Direct Stream",
      title: "Direktström (Avsnitt)",
      url: `${JF}/Videos/${epId}/stream?static=true&api_key=${jfToken}`
    }]
  };
});

// ============================================================================
// SERVER
// ============================================================================
const app = express();
const router = getRouter(builder.getInterface());
app.use(router);

app.get("/", (_req, res) => res.send(`OK - ${manifest.name}`));

app.listen(PORT, "0.0.0.0", () => {
  console.log("-----------------------------------------------------");
  console.log(`🚀 Addon redo på: ${PUBLIC_URL}/manifest.json`);
  console.log(`🌍 Lokalt: http://192.168.1.163:${PORT}/manifest.json`);
  console.log(`🎦 Jellyfin-server: ${JF}`);
  console.log(`⌛ Väntar på första inloggning/anmälan från Stremio...`);
  console.log("-----------------------------------------------------");
});
