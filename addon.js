// ============================================================================
//   Stremio Jellyfin Addon – Fresh Clean Build
//   All metadata + images working for Movies & Episodes
//   No endpoint issues, no missing fields, no undefined vars
// ============================================================================

const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");

// Fix for node 20+ dynamic import of node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
global.fetch = fetch;

const manifest = require("./manifest.json");

// Environment
const PORT = process.env.PORT || 60421;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JF = (process.env.JELLYFIN_SERVER || "").replace(/\/$/, "");
const JF_USER = process.env.JELLYFIN_USER || "";
const JF_PASS = process.env.JELLYFIN_PASSWORD || "";
const TMDB = process.env.TMDB_API_KEY || "";

// Jellyfin session memory
let jfToken = null;
let jfUserId = null;

// Helper: Jellyfin headers
function jfHeaders() {
	return {
		"Content-Type": "application/json",
		"X-Emby-Authorization":
			'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="addon-stremio", Version="1.0.0"',
		"X-MediaBrowser-Token": jfToken
	};
}

// Login
async function jfLogin() {
    console.log(`🔐 Logging into Jellyfin → ${JF}/Users/AuthenticateByName`);

    const body = {
        Username: JF_USER,
        Pw: JF_PASS,
        Password: JF_PASS,
        username: JF_USER,
        password: JF_PASS
    };

    const res = await fetch(`${JF}/Users/AuthenticateByName`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Emby-Authorization":
                'MediaBrowser Client="StremioAddon", Device="Addon", DeviceId="addon-stremio", Version="1.0.0"'
        },
        body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) {
        console.log("❌ Jellyfin replied with:", res.status, text);
        throw new Error(`Login failed: HTTP ${res.status}`);
    }

    let j;
    try {
        j = JSON.parse(text);
    } catch (e) {
        throw new Error("Login JSON parse error: " + e + " BODY=" + text);
    }

    jfToken = j.AccessToken;
    jfUserId = j.User?.Id;

    console.log(`✅ Logged in as ${j.User?.Name}`);
}

// Helpers for images
function jfPoster(it, w = 600) {
	if (!it?.Id || !it.PrimaryImageTag) return null;
	return `${JF}/Items/${it.Id}/Images/Primary?tag=${it.PrimaryImageTag}&quality=90&fillWidth=${w}&api_key=${jfToken}`;
}

function jfBackdrop(it, w = 1920) {
	const tag = it.BackdropImageTags?.[0] || it.PrimaryImageTag;
	if (!tag) return null;
	return `${JF}/Items/${it.Id}/Images/Backdrop?tag=${tag}&quality=90&fillWidth=${w}&api_key=${jfToken}`;
}

// TMDB lookup (optional)
async function tmdbLookup(title, year, isMovie) {
	if (!TMDB) return null;

	const type = isMovie ? "movie" : "tv";
	const url = `https://api.themoviedb.org/3/search/${type}?api_key=${TMDB}&query=${encodeURIComponent(
		title
	)}&language=sv-SE`;

	const r = await fetch(url);
	const j = await r.json();
	const hit = j.results?.[0];
	if (!hit) return null;

	const base = "https://image.tmdb.org/t/p/original";

	return {
		poster: hit.poster_path ? `${base}${hit.poster_path}` : null,
		backdrop: hit.backdrop_path ? `${base}${hit.backdrop_path}` : null,
		overview: hit.overview || null
	};
}

// STREMIO BUILDER
const builder = new addonBuilder(manifest);

// ============================================================================
// CATALOG
// ============================================================================
builder.defineCatalogHandler(async ({ type }) => {
	if (!jfToken) await jfLogin();

	const include = type === "movie" ? "Movie" : "Series";

	const url =
		`${JF}/Items?IncludeItemTypes=${include}` +
		`&Fields=PrimaryImageTag,ProductionYear` +
		`&Recursive=true&UserId=${jfUserId}`;

	const r = await fetch(url, { headers: jfHeaders() });
	const j = await r.json();
	const items = j.Items || [];

	const metas = await Promise.all(
		items.map(async it => {
			const tmdb = await tmdbLookup(it.Name, it.ProductionYear, type === "movie");
			return {
				id: `jf:${it.Id}`,
				type,
				name: it.Name,
				poster: tmdb?.poster || jfPoster(it),
				posterShape: "regular"
			};
		})
	);

	return { metas };
});

// ============================================================================
// META (MOVIE + SERIES)
// ============================================================================
builder.defineMetaHandler(async ({ type, id }) => {
	if (!jfToken) await jfLogin();

	const jfId = id.replace(/^jf:/, "");

	const metaUrl =
		`${JF}/Items/${jfId}` +
		`?Fields=PrimaryImageTag,Overview,Genres,ProductionYear,BackdropImageTags,RunTimeTicks` +
		`&UserId=${jfUserId}`;

	const r = await fetch(metaUrl, { headers: jfHeaders() });
	const it = await r.json();

	// ---------------- MOVIE ----------------
	if (type === "movie") {
		const tmdb = await tmdbLookup(it.Name, it.ProductionYear, true);

		return {
			meta: {
				id,
				type,
				name: it.Name,
				description: tmdb?.overview || it.Overview,
				poster: tmdb?.poster || jfPoster(it),
				background: tmdb?.backdrop || jfBackdrop(it),
				genres: it.Genres || [],
				releaseInfo: it.ProductionYear?.toString()
			}
		};
	}

	// ---------------- SERIES (EPISODES) ----------------
	const epsUrl =
		`${JF}/Items?ParentId=${jfId}` +
		`&IncludeItemTypes=Episode&Recursive=true` +
		`&Fields=PrimaryImageTag,ImageTags,BackdropImageTags,Overview,Name,ParentIndexNumber,IndexNumber,PremiereDate` +
		`&UserId=${jfUserId}`;

	const er = await fetch(epsUrl, { headers: jfHeaders() });
	const ej = await er.json();
	const eps = ej.Items || [];

	const videos = eps
		.map(ep => {
			const img =
				ep.PrimaryImageTag ||
				(ep.ImageTags && ep.ImageTags.Primary) ||
				null;

			return {
				id: `jf:${jfId}:${ep.ParentIndexNumber}:${ep.IndexNumber}:${ep.Id}`,
				name: ep.Name || `S${ep.ParentIndexNumber}E${ep.IndexNumber}`,
				overview: ep.Overview || "",
				season: ep.ParentIndexNumber,
				episode: ep.IndexNumber,
				released: ep.PremiereDate || null,
				thumbnail: img
					? `${JF}/Items/${ep.Id}/Images/Primary?tag=${img}&quality=90&api_key=${jfToken}`
					: null,
				poster: img
					? `${JF}/Items/${ep.Id}/Images/Primary?tag=${img}&quality=90&api_key=${jfToken}`
					: null,
				background: ep.BackdropImageTags?.[0]
					? `${JF}/Items/${ep.Id}/Images/Backdrop?tag=${ep.BackdropImageTags[0]}&quality=90&api_key=${jfToken}`
					: null
			};
		})
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
			description: it.Overview,
			poster: jfPoster(it),
			background: jfBackdrop(it),
			videos
		}
	};
});

// ============================================================================
// STREAM HANDLER
// ============================================================================
builder.defineStreamHandler(async ({ id, type }) => {
	if (!jfToken) await jfLogin();

	const parts = id.split(":");

	// Movie
	if (type === "movie") {
		const movieId = parts[1];
		return {
			streams: [
				{
					name: "Direct Stream",
					url: `${JF}/Videos/${movieId}/stream?static=true&api_key=${jfToken}`
				}
			]
		};
	}

	// Episode
	const epId = parts[4];
	return {
		streams: [
			{
				name: "Direct Stream",
				url: `${JF}/Videos/${epId}/stream?static=true&api_key=${jfToken}`
			}
		]
	};
});

// ============================================================================
// SERVER
// ============================================================================
const app = express();
const router = getRouter(builder.getInterface());
app.use(router);

app.listen(PORT, "0.0.0.0", () =>
	console.log(`🚀 Addon ready → ${PUBLIC_URL}/manifest.json`)
);