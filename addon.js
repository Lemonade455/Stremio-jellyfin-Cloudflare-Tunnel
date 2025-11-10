const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// === 🌍 Miljövariabler ===
const PORT = process.env.PORT || 60421;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JF = (process.env.JELLYFIN_SERVER || "").replace(/\/$/, "");
const JF_USER = process.env.JELLYFIN_USER || "";
const JF_PASS = process.env.JELLYFIN_PASSWORD || "";
const TMDB = process.env.TMDB_API_KEY || "";
const OMDB = process.env.OMDB_API_KEY || "";

// === 🔐 State ===
let jfToken = null;
let jfUserId = null;
const dataDir = path.join(__dirname, "data");
const tmdbCacheFile = path.join(dataDir, "tmdb-cache.json");

// === 🧱 Init cache ===
async function ensureDataDir() {
  try { await fsp.mkdir(dataDir, { recursive: true }); } catch (_) {}
  try {
    const st = await fsp.lstat(tmdbCacheFile).catch(() => null);
    if (st && st.isDirectory()) await fsp.rm(tmdbCacheFile, { recursive: true, force: true });
  } catch (_) {}
  try {
    await fsp.access(tmdbCacheFile).catch(async () => {
      await fsp.writeFile(tmdbCacheFile, "{}", "utf8");
    });
  } catch (_) {}
}

async function readCache() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(tmdbCacheFile, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    await fsp.writeFile(tmdbCacheFile, "{}", "utf8");
    return {};
  }
}

async function writeCache(obj) {
  await ensureDataDir();
  try {
    await fsp.writeFile(tmdbCacheFile, JSON.stringify(obj), "utf8");
  } catch (e) {
    console.warn("⚠️ kunde inte skriva TMDB-cache:", e.message);
  }
}

// === 🔢 Hjälpfunktioner ===
function ticksToMinutes(runTimeTicks) {
  if (!runTimeTicks || runTimeTicks <= 0) return undefined;
  const seconds = Math.round(runTimeTicks / 10000000);
  return Math.max(1, Math.round(seconds / 60));
}

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
  jfUserId = j.User && j.User.Id;
  console.log(`✅ Inloggad som ${JF_USER} via ${JF}`);
}

function jfHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Emby-Authorization":
      'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="stremio-addon", Version="4.0.0"',
    "X-MediaBrowser-Token": jfToken || ""
  };
}

// === 📡 Jellyfin Helpers ===
async function jfItems(type) {
  const include = type === "movie" ? "Movie" : "Series";
  const url = `${JF}/Items?IncludeItemTypes=${include}&Recursive=true&Fields=PrimaryImageAspectRatio,Overview,Genres,ProductionYear,RunTimeTicks,ProviderIds,BackdropImageTags,PrimaryImageTag&Limit=500&UserId=${encodeURIComponent(jfUserId)}`;
  const r = await fetch(url, { headers: jfHeaders() });
  if (!r.ok) throw new Error(`Items HTTP ${r.status}`);
  const j = await r.json();
  return (j && j.Items) || [];
}

function jfPosterUrl(item, w = 400) {
  if (!item || !item.Id) return undefined;
  if (item.PrimaryImageTag)
    return `${JF}/Items/${item.Id}/Images/Primary?fillWidth=${w}&quality=90&tag=${item.PrimaryImageTag}&api_key=${jfToken}`;
}

function jfBackdropUrl(item, w = 1280) {
  if (!item || !item.Id) return undefined;
  const tag =
    (item.BackdropImageTags && item.BackdropImageTags[0]) || item.PrimaryImageTag;
  if (tag)
    return `${JF}/Items/${item.Id}/Images/Backdrop?fillWidth=${w}&quality=90&tag=${tag}&api_key=${jfToken}`;
}

// === 🎬 TMDB & OMDB ===
async function tmdbLookup(title, year, isMovie = true) {
  if (!TMDB) return null;
  const cache = await readCache();
  const key = `${isMovie ? "m" : "s"}|${title}|${year || ""}`;
  if (cache[key]) return cache[key];

  const base = "https://api.themoviedb.org/3";
  const path = isMovie ? "/search/movie" : "/search/tv";
  const q = new URLSearchParams({
    api_key: TMDB,
    query: title,
    language: "sv-SE",
    include_adult: "false"
  });
  if (year)
    q.set(isMovie ? "year" : "first_air_date_year", String(year));
  const url = `${base}${path}?${q}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const hit = (j.results && j.results[0]) || null;
    if (hit) {
      const imageBase = "https://image.tmdb.org/t/p/original";
      const out = {
        title: hit.title || hit.name || title,
        overview: hit.overview || null,
        poster: hit.poster_path ? `${imageBase}${hit.poster_path}` : null,
        backdrop: hit.backdrop_path
          ? `${imageBase}${hit.backdrop_path}`
          : null,
        year:
          (hit.release_date || hit.first_air_date || "").slice(0, 4) ||
          year ||
          null,
        imdbRating:
          typeof hit.vote_average === "number"
            ? Number(hit.vote_average.toFixed(1))
            : null
      };
      cache[key] = out;
      await writeCache(cache);
      console.log(
        `🎬 TMDB: ${out.title} (${out.year}) ⭐ ${out.imdbRating || "?"}`
      );
      return out;
    }
  } catch (e) {
    console.warn(`⚠️ TMDB misslyckades: ${e.message}`);
  }
  return null;
}

// === 🧩 Stremio Addon ===
const manifest = require("./manifest.json");
const builder = new addonBuilder(manifest);

// === 📚 Katalog ===
builder.defineCatalogHandler(async ({ type }) => {
  try {
    if (!jfToken) await jfLogin();
    const items = await jfItems(type);
    const metas = await Promise.all(
      items.map(async (it) => {
        const title = it.Name;
        const year = it.ProductionYear;
        const t = await tmdbLookup(title, year, type === "movie");
        const poster = t?.poster || jfPosterUrl(it, 500);
        return {
          id: `jf:${it.Id}`,
          type,
          name: title,
          poster,
          posterShape: "regular"
        };
      })
    );
    console.log(`📚 Katalog laddad (${type}): ${metas.length} objekt`);
    return { metas };
  } catch (e) {
    console.error("Catalog error:", e.message);
    return { metas: [] };
  }
});

// === 🧩 Metadata ===
builder.defineMetaHandler(async ({ type, id }) => {
  try {
    if (!jfToken) await jfLogin();
    const jfId = String(id).replace(/^jf:/, "");
    const url = `${JF}/Items/${jfId}?Fields=PrimaryImageAspectRatio,Overview,Genres,ProductionYear,RunTimeTicks,BackdropImageTags,PrimaryImageTag,ProviderIds&UserId=${encodeURIComponent(jfUserId)}`;
    const r = await fetch(url, { headers: jfHeaders() });
    const it = await r.json();
    const t = await tmdbLookup(it.Name, it.ProductionYear, type === "movie");
    const poster = t?.poster || jfPosterUrl(it, 700);
    const background = t?.backdrop || jfBackdropUrl(it, 1920);
    const minutes = ticksToMinutes(it.RunTimeTicks);
    const description = (t?.overview || it.Overview || "").trim();
    const imdb = t?.imdbRating || "N/A";

    console.log(`🧩 Meta: ${it.Name} (${it.ProductionYear}) ⭐ ${imdb}`);

    return {
      meta: {
        id,
        type,
        name: it.Name,
        poster,
        background,
        description,
        releaseInfo: it.ProductionYear?.toString(),
        runtime: minutes ? `${minutes} min` : undefined,
        genres: it.Genres,
        imdbRating: imdb
      }
    };
  } catch (e) {
    console.error("Meta error:", e.message);
    return { meta: { id, type, name: "Okänt objekt" } };
  }
});

// === 🎞️ Stream (filmer + serier med säsonger & avsnitt) ===
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    if (!jfToken) await jfLogin();
    const jfId = String(id).replace(/^jf:/, "");

    // === Film ===
    if (type === "movie") {
      const streamUrl = `${JF}/Videos/${jfId}/stream?static=true&api_key=${jfToken}`;
      console.log(`🎬 Film: Direct → ${streamUrl}`);
      return {
        streams: [
          { name: "Direct Stream", title: "Direktström (Film)", url: streamUrl }
        ]
      };
    }

    // === Serie ===
    if (type === "series") {
      const allStreams = [];

      // 1️⃣ Försök hämta säsonger
      const seasonsUrl = `${JF}/Shows/${jfId}/Seasons?UserId=${jfUserId}`;
      const sRes = await fetch(seasonsUrl, { headers: jfHeaders() });
      const seasons = sRes.ok ? (await sRes.json()).Items || [] : [];

      if (seasons.length > 0) {
        for (const s of seasons) {
          const episodesUrl = `${JF}/Shows/${jfId}/Episodes?seasonId=${s.Id}&UserId=${jfUserId}`;
          const eRes = await fetch(episodesUrl, { headers: jfHeaders() });
          const eJson = eRes.ok ? await eRes.json() : {};
          const episodes = eJson.Items || [];
          for (const ep of episodes) {
            const epTitle = `${s.Name || "Säsong"} ${s.IndexNumber || ""}, Avsnitt ${ep.IndexNumber || ""} – ${ep.Name}`;
            const streamUrl = `${JF}/Videos/${ep.Id}/stream?static=true&api_key=${jfToken}`;
            allStreams.push({
              name: "Direct Stream",
              title: epTitle,
              url: streamUrl
            });
          }
        }
        console.log(`📺 Serie: ${seasons.length} säsonger, ${allStreams.length} avsnitt hittade`);
      } else {
        // 2️⃣ Fallback – direkt episoder
        const itemsUrl = `${JF}/Items?ParentId=${jfId}&IncludeItemTypes=Episode&UserId=${jfUserId}`;
        const r = await fetch(itemsUrl, { headers: jfHeaders() });
        const j = r.ok ? await r.json() : {};
        const episodes = j.Items || [];
        for (const ep of episodes) {
          const epTitle = `Avsnitt ${ep.IndexNumber || ""} – ${ep.Name}`;
          const streamUrl = `${JF}/Videos/${ep.Id}/stream?static=true&api_key=${jfToken}`;
          allStreams.push({
            name: "Direct Stream",
            title: epTitle,
            url: streamUrl
          });
        }
        console.log(`📺 Serie utan säsonger: ${allStreams.length} avsnitt hittade`);
      }

      if (allStreams.length === 0)
        console.warn(`⚠️ Inga avsnitt kunde hämtas för ${jfId}`);

      return { streams: allStreams };
    }

    return { streams: [] };
  } catch (e) {
    console.error(`Stream error (${type}):`, e.message);
    return { streams: [] };
  }
});

// === 🚀 Start server ===
const app = express();
const router = getRouter(builder.getInterface());
app.use(router);

app.get("/", (_req, res) =>
  res.send(`OK - ${manifest.name}`)
);

app.listen(PORT, "0.0.0.0", async () => {
  console.log("-----------------------------------------------------");
  console.log(`🚀 Addon redo på: ${PUBLIC_URL}/manifest.json`);
  console.log(`🌍 Lokalt tillgänglig på: http://192.168.1.163:${PORT}/manifest.json`);
  console.log(`🎦 Ansluten till Jellyfin-server: ${JF}`);
  console.log("-----------------------------------------------------");
});