// ============================================================================
// BUILD: 2025-02-15_04
// Stremio Jellyfin Addon – Svensk metadata, snabb caching, optimerad laddning
// ============================================================================

const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");

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
const jfCacheFile = path.join(dataDir, "jf-cache.json");

// ============================================================================
// CACHE INIT
// ============================================================================
async function ensureDataDir() {
  try { await fsp.mkdir(dataDir, { recursive: true }); } catch (_) {}
}

async function readJsonCache(file) {
  await ensureDataDir();
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (_) { await fsp.writeFile(file, "{}", "utf8"); return {}; }
}

async function writeJsonCache(file, obj) {
  await ensureDataDir();
  await fsp.writeFile(file, JSON.stringify(obj), "utf8");
}

// TMDB cache
async function readTmdbCache() { return readJsonCache(tmdbCacheFile); }
async function writeTmdbCache(obj) { return writeJsonCache(tmdbCacheFile, obj); }

// Jellyfin cache
async function readJfCache() { return readJsonCache(jfCacheFile); }
async function writeJfCache(obj) { return writeJsonCache(jfCacheFile, obj); }

// ============================================================================
// SWEDISH TEXT FIXER
// ============================================================================
function ensureSwedish(text) {
  if (!text) return null;
  if (/[åäöÅÄÖ]/.test(text)) return text;

  return text
    .replace(/\bSeason\b/gi, "Säsong")
    .replace(/\bEpisode\b/gi, "Avsnitt")
    .replace(/\bMovie\b/gi, "Film")
    .replace(/\bOverview\b/gi, "Översikt");
}

// ============================================================================
// TMDB LOOKUP (24h cache)
// ============================================================================
async function tmdbLookup(title, year, isMovie = true) {
  if (!TMDB) return null;

  const cache = await readTmdbCache();
  const key = `${isMovie ? "m" : "s"}|${title}|${year}`;
  const now = Date.now();

  if (cache[key] && now - cache[key].ts < 24 * 60 * 60 * 1000) {
    return cache[key].data;
  }

  const base = "https://api.themoviedb.org/3";
  const path = isMovie ? "/search/movie" : "/search/tv";

  const params = new URLSearchParams({
    api_key: TMDB,
    query: title,
    language: "sv-SE",
    include_adult: "false"
  });

  if (year) params.set(isMovie ? "year" : "first_air_date_year", String(year));

  const r = await fetch(`${base}${path}?${params}`);
  const j = await r.json();
  const hit = j.results?.[0];

  if (!hit) return null;

  const img = "https://image.tmdb.org/t/p/original";

  const out = {
    title: hit.title || hit.name,
    overview: ensureSwedish(hit.overview),
    poster: hit.poster_path ? `${img}${hit.poster_path}` : null,
    backdrop: hit.backdrop_path ? `${img}${hit.backdrop_path}` : null,
    year: (hit.release_date || hit.first_air_date || "").slice(0, 4) || year,
    imdbRating: hit.vote_average ? Number(hit.vote_average.toFixed(1)) : null
  };

  cache[key] = { ts: now, data: out };
  await writeTmdbCache(cache);

  return out;
}

// ============================================================================
// JELLYFIN CACHING (TTL-per-request)
// ============================================================================
async function getCachedJF(id, url, ttl = 20 * 60 * 1000) {
  const cache = await readJfCache();
  const now = Date.now();

  if (cache[id] && (now - cache[id].ts < ttl)) {
    console.log(`⚡ Cache-hit: ${id}`);
    return cache[id].data;
  }

  console.log(`🌐 API: ${id}`);
  const r = await fetch(url, { headers: jfHeaders() });
  const j = await r.json();

  cache[id] = { ts: now, data: j };
  await writeJfCache(cache);

  return j;
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
  console.log(`🔐 Loggar in på Jellyfin: ${JF}`);

  const res = await fetch(`${JF}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="stremio-addon", Version="4.0.0"'
    },
    body: JSON.stringify({
      Username: JF_USER,
      Password: JF_PASS,
      Pw: JF_PASS,
      username: JF_USER
    })
  });

  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);
  const j = await res.json();

  jfToken = j.AccessToken;
  jfUserId = j.User?.Id;

  console.log(`✅ Inloggad som: ${j.User?.Name}`);
  return true;
}

// ============================================================================
// STREMIO ADDON
// ============================================================================
const manifest = require("./manifest.json");
const builder = new addonBuilder(manifest);

// ============================================================================
// CATALOG (4h cache)
// ============================================================================
builder.defineCatalogHandler(async ({ type }) => {
  if (!jfToken) await jfLogin();

  const include = type === "movie" ? "Movie" : "Series";
  const url =
    `${JF}/Items?IncludeItemTypes=${include}&Recursive=true&Fields=PrimaryImageTag,ProductionYear&UserId=${jfUserId}`;

  const j = await getCachedJF(`catalog:${type}`, url, 4 * 60 * 60 * 1000);
  const items = j.Items || [];

  const metas = await Promise.all(
    items.map(async it => {
      const tm = await tmdbLookup(it.Name, it.ProductionYear, type === "movie");
      return {
        id: `jf:${it.Id}`,
        type,
        name: tm?.title || it.Name,
        poster: tm?.poster || (it.PrimaryImageTag ?
          `${JF}/Items/${it.Id}/Images/Primary?tag=${it.PrimaryImageTag}&api_key=${jfToken}` : null),
        posterShape: "regular"
      };
    })
  );

  return { metas };
});

// ============================================================================
// META HANDLER (20m cache)
// ============================================================================
builder.defineMetaHandler(async ({ type, id }) => {
  if (!jfToken) await jfLogin();

  const jfId = id.replace(/^jf:/, "");

  const metaUrl =
    `${JF}/Items/${jfId}?Fields=PrimaryImageTag,Overview,Genres,ProductionYear,BackdropImageTags,RunTimeTicks&UserId=${jfUserId}`;

  const it = await getCachedJF(`meta:${jfId}`, metaUrl, 20 * 60 * 1000);

  // Film
  if (type === "movie") {
    const t = await tmdbLookup(it.Name, it.ProductionYear, true);

    return {
      meta: {
        id,
        type,
        name: t?.title || it.Name,
        poster: t?.poster,
        background: t?.backdrop,
        description: ensureSwedish(t?.overview || it.Overview),
        releaseInfo: String(it.ProductionYear),
        runtime: ticksToMinutes(it.RunTimeTicks),
        genres: it.Genres,
        imdbRating: t?.imdbRating || "N/A"
      }
    };
  }

  // Serie → episoder
  const epsUrl =
    `${JF}/Items?ParentId=${jfId}&IncludeItemTypes=Episode&Recursive=true` +
    `&Fields=ParentIndexNumber,IndexNumber,Overview,PremiereDate,ImageTags,BackdropImageTags&UserId=${jfUserId}`;

  const ej = await getCachedJF(`eps:${jfId}`, epsUrl, 20 * 60 * 1000);
  const eps = ej.Items || [];

  const videos = eps
    .map(ep => ({
      id: `jf:${jfId}:${ep.ParentIndexNumber}:${ep.IndexNumber}:${ep.Id}`,
      title: ep.Name || `S${ep.ParentIndexNumber}E${ep.IndexNumber}`,
      overview: ensureSwedish(ep.Overview),
      season: ep.ParentIndexNumber,
      episode: ep.IndexNumber,
      released: ep.PremiereDate,
      thumbnail: ep.ImageTags?.Primary
        ? `${JF}/Items/${ep.Id}/Images/Primary?tag=${ep.ImageTags.Primary}&api_key=${jfToken}`
        : null
    }))
    .sort((a, b) =>
      a.season === b.season ? a.episode - b.episode : a.season - b.season
    );

  return {
    meta: {
      id,
      type: "series",
      name: it.Name,
      poster: it.PrimaryImageTag ?
        `${JF}/Items/${it.Id}/Images/Primary?tag=${it.PrimaryImageTag}&api_key=${jfToken}` : null,
      background: it.BackdropImageTags?.[0] ?
        `${JF}/Items/${it.Id}/Images/Backdrop?tag=${it.BackdropImageTags[0]}&api_key=${jfToken}` : null,
      description: ensureSwedish(it.Overview),
      videos
    }
  };
});

// ============================================================================
// STREAMS
// ============================================================================
builder.defineStreamHandler(async ({ id, type }) => {
  if (!jfToken) await jfLogin();

  const parts = id.split(":");

  if (type === "movie") {
    const jfId = parts[1];
    return {
      streams: [{
        name: "Direktström",
        title: "Direktström (Film)",
        url: `${JF}/Videos/${jfId}/stream?static=true&api_key=${jfToken}`
      }]
    };
  }

  const epId = parts[4];
  return {
    streams: [{
      name: "Direktström",
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

app.get("/", (_req, res) => res.send(`OK - ${manifest.name} (svensk build)`));

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================================");
  console.log(`🚀 Addon redo → ${PUBLIC_URL}/manifest.json`);
  console.log(`🎦 Jellyfin → ${JF}`);
  console.log(`🌍 Lyssnar på port ${PORT}`);
  console.log("====================================================");
});
