import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import sharp from "sharp";

dotenv.config();

const app = express();
app.use(cookieParser());

// CORS (no trailing slash!)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 8000;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  throw new Error("Missing env vars. Check backend/.env");
}

const COLOR_ORDER = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "white",
  "grey",
  "black",
];

// ✅ Never include 1-song albums (everywhere)
function isOneTrackAlbum(albumLike) {
  const t = albumLike?.total_tracks;
  return typeof t === "number" && t <= 1;
}

/**
 * ✅ Deterministic variety helpers (no flicker)
 */
function hashStringToInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function albumStrengthValue(a) {
  // prioritize "score" heavily, then confidence a bit, then count slightly
  const score = typeof a?.score === "number" ? a.score : 0;
  const conf = typeof a?.confidence === "number" ? a.confidence : 0;
  const cnt = typeof a?.count === "number" ? a.count : 0;
  return score * 1.0 + conf * 0.55 + Math.min(10, cnt) * 0.03;
}

/**
 * ✅ Prefer the best album if it's clearly better; otherwise choose deterministically from top N.
 * - dominanceMargin: how much stronger #1 must be (as a fraction) to "lock in"
 */
function pickPreferBestOrVariety(list, n, key, dominanceMargin = 0.25) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length === 1) return list[0];

  const best = list[0];
  const runnerUp = list[1];

  const bestV = albumStrengthValue(best);
  const upV = albumStrengthValue(runnerUp);

  // If #1 is clearly stronger, keep it (allows the same albums across timeframes for good reason)
  if (upV <= 0 || bestV >= upV * (1 + dominanceMargin)) {
    return best;
  }

  // Otherwise add variety within top-N window
  const window = Math.max(1, Math.min(n, list.length));
  const idx = hashStringToInt(key) % window;
  return list[idx];
}

/**
 * ✅ Time-range–dependent strictness + variety window
 * short_term: stricter + strong lock-in to best
 * long_term: looser + more variety if top options are close
 */
function strictnessForRange(timeRange) {
  if (timeRange === "long_term") {
    return {
      minConf: 0.18,
      minConfWide: 0.10,
      savedScan: 900,
      savedScanWide: 1600,
      topArtistsN: 14,
      albumsPerArtist: 22,
      candidateCap: 240,
      topTrackPagesWide: 4,
      firstEnrich: 520,
      enrichBatch: 240,
      maxTotalEnrich: 1600,
      pickWindow: 3, // ✅ more variety
      dominanceMargin: 0.32, // allow variety unless #1 is clearly stronger
    };
  }
  if (timeRange === "medium_term") {
    return {
      minConf: 0.22,
      minConfWide: 0.12,
      savedScan: 650,
      savedScanWide: 1200,
      topArtistsN: 12,
      albumsPerArtist: 18,
      candidateCap: 200,
      topTrackPagesWide: 3,
      firstEnrich: 520,
      enrichBatch: 220,
      maxTotalEnrich: 1400,
      pickWindow: 2, // ✅ medium variety
      dominanceMargin: 0.42, // moderate lock-in
    };
  }
  // short_term
  return {
    minConf: 0.26,
    minConfWide: 0.14,
    savedScan: 450,
    savedScanWide: 900,
    topArtistsN: 10,
    albumsPerArtist: 16,
    candidateCap: 180,
    topTrackPagesWide: 3,
    firstEnrich: 520,
    enrichBatch: 200,
    maxTotalEnrich: 1200,
    pickWindow: 1, // ✅ subtle variety
    dominanceMargin: 0.55, // strong lock-in for short_term
  };
}

app.get("/", (req, res) => {
  res.send(`
    <h1>ChromaFM</h1>
    <p><a href="/login">Login with Spotify</a></p>
    <p>After login, visit <a href="/api/results">/api/results</a>
  `);
});

app.get("/login", (req, res) => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: "user-top-read user-library-read",
    redirect_uri: REDIRECT_URI,
    show_dialog: "true",
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code.toString(),
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res
        .status(500)
        .send("Token error: " + escapeHtml(JSON.stringify(tokenData, null, 2)));
    }

    res.cookie("access_token", tokenData.access_token, {
      httpOnly: true,
      sameSite: "lax",
    });

    return res.redirect("http://127.0.0.1:5173/");
  } catch (err) {
    res.status(500).send("Server error: " + escapeHtml(String(err)));
  }
});

/**
 * Spotify API helpers
 */
async function fetchTopTracks(accessToken, time_range, limit = 50, offset = 0) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?limit=${limit}&offset=${offset}&time_range=${encodeURIComponent(
      time_range
    )}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error("Spotify top tracks failed: " + JSON.stringify(json));
  return json;
}

async function fetchTopArtists(accessToken, limit = 10) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/artists?limit=${limit}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error("Spotify top artists failed: " + JSON.stringify(json));
  return json;
}

async function fetchArtistAlbums(accessToken, artistId, limit = 12) {
  const url =
    `https://api.spotify.com/v1/artists/${artistId}/albums` +
    `?include_groups=album,single,compilation&limit=${limit}&market=from_token`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await res.json();
  if (!res.ok) throw new Error("Artist albums failed: " + JSON.stringify(json));
  return json;
}

async function fetchSavedAlbums(accessToken, limit = 50, offset = 0) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/albums?limit=${limit}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error("Saved albums failed: " + JSON.stringify(json));
  return json;
}

/**
 * Normalization + ranking
 */
function normalizeAlbumName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(
      /\b(deluxe|remaster(ed)?|edition|anniversary|expanded|reissue|bonus|mono|stereo)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function rankWeight(index, total) {
  const t = total <= 1 ? 1 : index / (total - 1);
  const w = 1 - t;
  return w * w;
}

/**
 * Dominant color cache
 */
const DOMINANT_CACHE = new Map();
const DOMINANT_CACHE_MAX = 1200;

function cacheGet(key) {
  return DOMINANT_CACHE.get(key) || null;
}
function cacheSet(key, value) {
  DOMINANT_CACHE.set(key, value);
  if (DOMINANT_CACHE.size > DOMINANT_CACHE_MAX) {
    const firstKey = DOMINANT_CACHE.keys().next().value;
    DOMINANT_CACHE.delete(firstKey);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

async function enrichWithDominant(albums, concurrency = 6) {
  await mapLimit(albums, concurrency, async (a) => {
    if (!a.image) {
      a.hex = null;
      a.confidence = 0;
      a.low_confidence = true;
      return;
    }
    try {
      const { hex, confidence } = await getDominantFromImage(a.image);
      a.hex = hex;
      a.confidence = confidence;
      a.low_confidence = confidence < 0.25;
    } catch {
      a.hex = null;
      a.confidence = 0;
      a.low_confidence = true;
    }
  });
  return albums;
}

// ✅ Enrich more candidates in batches when needed
async function enrichMoreIfNeeded(pool, startIndex, count, concurrency = 6) {
  const slice = pool.slice(startIndex, startIndex + count);
  const toEnrich = slice.filter((a) => a && !a.hex && a.image);
  if (!toEnrich.length) return 0;
  await enrichWithDominant(toEnrich, concurrency);
  return toEnrich.length;
}

/**
 * Build candidate albums from top tracks for a time range (supports paging)
 * - merges by normalized album name + primary artist name
 * - NEVER includes 1-track albums
 */
async function gatherTopTrackCandidates(accessToken, timeRange, opts = {}) {
  const { pages = 1, pageSize = 50, maxUnique = 260, timeWeight = 1.0 } = opts;

  const albumMap = Object.create(null);
  const totalApprox = Math.max(1, pages * pageSize);

  for (let p = 0; p < pages; p++) {
    const top = await fetchTopTracks(accessToken, timeRange, pageSize, p * pageSize);
    const items = top.items || [];

    items.forEach((track, index) => {
      const globalIndex = p * pageSize + index;
      const album = track.album;
      if (!album?.id) return;

      if (isOneTrackAlbum(album)) return;

      const primaryArtistName = album.artists?.[0]?.name || "";
      const normName = normalizeAlbumName(album.name);
      const key = `${normName}::${primaryArtistName.toLowerCase()}`;

      const wRank = rankWeight(globalIndex, totalApprox);
      const score = wRank * timeWeight;

      if (!albumMap[key]) {
        albumMap[key] = {
          id: album.id,
          name: album.name,
          artist: (album.artists || []).map((a) => a.name).join(", "),
          image: album.images?.[0]?.url || null,
          total_tracks: album.total_tracks,
          score: 0,
          appearances: 0,
          count: 0,
        };
      }

      albumMap[key].score += score;
      albumMap[key].appearances += 1;
      albumMap[key].count += 1;
    });

    if (items.length < pageSize) break;
  }

  return Object.values(albumMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxUnique);
}

function buildEmptyResult() {
  const result = {};
  for (const c of COLOR_ORDER) result[c] = { top: null, others: [] };
  return result;
}

function cmpAlbumStrength(a, b) {
  const as = typeof a?.score === "number" ? a.score : 0;
  const bs = typeof b?.score === "number" ? b.score : 0;
  if (bs !== as) return bs - as;

  const ac = typeof a?.confidence === "number" ? a.confidence : 0;
  const bc = typeof b?.confidence === "number" ? b.confidence : 0;
  if (bc !== ac) return bc - ac;

  const an = typeof a?.count === "number" ? a.count : 0;
  const bn = typeof b?.count === "number" ? b.count : 0;
  return bn - an;
}

// ✅ Ensure no duplicate album id across colors for tops
function enforceUniqueTops(result) {
  const seen = new Map(); // albumId -> color
  const dupColors = new Set();

  for (const color of COLOR_ORDER) {
    const top = result[color]?.top;
    const id = top?.id;
    if (!id) continue;

    if (!seen.has(id)) {
      seen.set(id, color);
      continue;
    }

    const otherColor = seen.get(id);
    const a = result[color]?.top;
    const b = result[otherColor]?.top;

    if (cmpAlbumStrength(a, b) < 0) {
      result[color].top = null;
      result[color].others = [];
      dupColors.add(color);
    } else {
      result[otherColor].top = null;
      result[otherColor].others = [];
      dupColors.add(otherColor);
      seen.set(id, color);
    }
  }

  return dupColors;
}

function getUsedAlbumIds(result) {
  const used = new Set();
  for (const c of COLOR_ORDER) {
    const id = result[c]?.top?.id;
    if (id) used.add(id);
  }
  return used;
}

function pickBestMatchingFromPool(pool, targetColor, usedIds, minConf = 0.2) {
  let best = null;

  for (const a of pool) {
    if (!a?.id || usedIds.has(a.id)) continue;
    if (!a.hex) continue;

    const conf = typeof a.confidence === "number" ? a.confidence : 0;
    if (conf < minConf) continue;

    const bucket = hexToSimpleBucket(a.hex);
    if (bucket !== targetColor) continue;

    if (!best || cmpAlbumStrength(a, best) < 0) best = a;
  }

  return best;
}

/**
 * Backfill: saved albums (bucket match)
 * - NEVER includes 1-track albums
 */
async function findSavedAlbumBackfillForColor(accessToken, targetColor, usedIds, opts = {}) {
  const MIN_CONF = typeof opts.minConf === "number" ? opts.minConf : 0.2;

  const PAGE_SIZE = 50;
  const MAX_TO_SCAN = typeof opts.maxToScan === "number" ? opts.maxToScan : 300;
  const pages = Math.ceil(MAX_TO_SCAN / PAGE_SIZE);

  let best = null;

  for (let p = 0; p < pages; p++) {
    const saved = await fetchSavedAlbums(accessToken, PAGE_SIZE, p * PAGE_SIZE);
    const items = saved.items || [];

    for (const it of items) {
      const album = it?.album;
      if (!album?.id) continue;
      if (usedIds?.has(album.id)) continue;

      if (isOneTrackAlbum(album)) continue;

      const image = album.images?.[0]?.url || null;
      if (!image) continue;

      try {
        const { hex, confidence } = await getDominantFromImage(image);
        if (!hex) continue;
        if (confidence < MIN_CONF) continue;

        const bucket = hexToSimpleBucket(hex);
        if (bucket !== targetColor) continue;

        const candidate = {
          id: album.id,
          name: album.name,
          artist: (album.artists || []).map((a) => a.name).join(", "),
          image,
          source: "saved_album_backfill",
          score: 0,
          count: 0,
          total_tracks: album.total_tracks,
          hex,
          confidence,
        };

        if (!best || candidate.confidence > best.confidence) best = candidate;
      } catch {
        // skip
      }
    }

    if (items.length < PAGE_SIZE) break;
  }

  return best;
}

/**
 * Backfill: top artists' albums (bucket match)
 * - NEVER includes 1-track albums
 */
async function findArtistBackfillForColor(accessToken, targetColor, usedIds, opts = {}) {
  const MIN_CONF = typeof opts.minConf === "number" ? opts.minConf : 0.2;

  const TOP_ARTISTS_N = typeof opts.topArtistsN === "number" ? opts.topArtistsN : 8;
  const ALBUMS_PER_ARTIST = typeof opts.albumsPerArtist === "number" ? opts.albumsPerArtist : 12;
  const CANDIDATE_CAP = typeof opts.candidateCap === "number" ? opts.candidateCap : 90;

  const topArtists = await fetchTopArtists(accessToken, TOP_ARTISTS_N);
  const artists = topArtists.items || [];

  const seenAlbumIds = new Set();
  const candidates = [];

  for (const artist of artists) {
    const albumsRes = await fetchArtistAlbums(accessToken, artist.id, ALBUMS_PER_ARTIST);
    for (const item of albumsRes.items || []) {
      if (!item?.id) continue;
      if (usedIds?.has(item.id)) continue;
      if (seenAlbumIds.has(item.id)) continue;

      if (isOneTrackAlbum(item)) continue;

      seenAlbumIds.add(item.id);

      const image = item.images?.[0]?.url || null;
      if (!image) continue;

      candidates.push({
        id: item.id,
        name: item.name,
        artist: (item.artists || []).map((a) => a.name).join(", "),
        image,
        total_tracks: item.total_tracks,
        source: "artist_backfill",
        score: 0,
        count: 0,
      });

      if (candidates.length >= CANDIDATE_CAP) break;
    }
    if (candidates.length >= CANDIDATE_CAP) break;
  }

  let best = null;

  await mapLimit(candidates, 6, async (c) => {
    try {
      const { hex, confidence } = await getDominantFromImage(c.image);
      if (!hex) return;
      if (confidence < MIN_CONF) return;

      const bucket = hexToSimpleBucket(hex);
      if (bucket !== targetColor) return;

      const enriched = { ...c, hex, confidence };
      if (!best || enriched.confidence > best.confidence) best = enriched;
    } catch {
      // skip
    }
  });

  return best;
}

/**
 * Nearest hue matching (used for "never-null" fallback)
 */
function targetBucketToHSVCenter(bucket) {
  if (bucket === "white") return { h: 0, s: 0.03, v: 0.96, type: "neutral" };
  if (bucket === "grey") return { h: 0, s: 0.1, v: 0.55, type: "neutral" };
  if (bucket === "black") return { h: 0, s: 0.1, v: 0.1, type: "neutral" };

  const centers = {
    red: 0,
    orange: 30,
    yellow: 60,
    green: 120,
    blue: 210,
    purple: 270,
    pink: 315,
  };
  return { h: centers[bucket] ?? 0, s: 0.45, v: 0.62, type: "hue" };
}

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function distanceToTarget(bucket, hex) {
  try {
    const { r, g, b } = hexToRgb(hex);
    const hsv = rgbToHsv(r, g, b);
    const target = targetBucketToHSVCenter(bucket);

    if (target.type === "neutral") {
      const ds = Math.abs(hsv.s - target.s);
      const dv = Math.abs(hsv.v - target.v);
      return 1.8 * dv + 1.2 * ds;
    } else {
      const dh = hueDistance(hsv.h, target.h) / 180;
      const ds = Math.max(0, target.s - hsv.s);
      const dv = Math.abs(hsv.v - target.v);
      return 1.4 * dh + 0.9 * ds + 0.5 * dv;
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * ✅ allow "nearest hue" even when confidence is VERY low
 * - no hard confidence cutoff
 * - soft penalty for low confidence so decent covers still win when close
 */
function pickClosestMatch(pool, targetColor, usedIds) {
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const a of pool) {
    if (!a?.id || usedIds.has(a.id)) continue;
    if (!a.hex) continue;

    const d = distanceToTarget(targetColor, a.hex);

    const conf = typeof a.confidence === "number" ? a.confidence : 0;
    const penalty = (1 - conf) * 0.12;
    const score = d + penalty;

    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }

  return best;
}

/**
 * Core compute function
 * Priority (variety, but only when the top picks are close):
 * 1) Top tracks (requested range)
 * 2) Saved albums
 * 3) Top artists albums
 * 4) Widen within requested range FIRST (deep paging) + nearest hue
 * 5) Only if still missing: pull from other time ranges (true last resort)
 */
async function computeResultsForRange(accessToken, requestedRange, limit, opts = {}) {
  const allRanges =
    Array.isArray(opts.allRanges) && opts.allRanges.length
      ? opts.allRanges
      : ["short_term", "medium_term", "long_term"];

  const S = strictnessForRange(requestedRange);

  // 1) requested range top tracks candidates
  const candidates = await gatherTopTrackCandidates(accessToken, requestedRange, {
    pages: 1,
    pageSize: limit,
    maxUnique: 260,
    timeWeight: 1.0,
  });

  // small top-artist reinforcement
  let artistBonus = Object.create(null);
  try {
    const artists = await fetchTopArtists(accessToken, 12);
    const aitems = artists.items || [];
    aitems.forEach((a, i) => {
      artistBonus[a.name] = (aitems.length - i) / 22;
    });
  } catch {
    artistBonus = Object.create(null);
  }

  for (const album of candidates) {
    const primary = (album.artist || "").split(",")[0].trim();
    if (artistBonus[primary]) album.score += artistBonus[primary];
  }

  const DOMINANCE_CAP = 3.0;

  const limited = candidates
    .map((a) => ({ ...a, score: Math.min(a.score, DOMINANCE_CAP) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 35);

  await enrichWithDominant(limited, 6);

  // bucketize initial
  const buckets = Object.create(null);
  for (const c of COLOR_ORDER) buckets[c] = [];
  buckets.unknown = [];

  for (const a of limited) {
    if (!a.hex) {
      buckets.unknown.push(a);
      continue;
    }
    const bucket = hexToSimpleBucket(a.hex);
    (buckets[bucket] || buckets.unknown).push(a);
  }

  for (const k of Object.keys(buckets)) {
    buckets[k].sort((x, y) => cmpAlbumStrength(x, y));
  }

  // ✅ Prefer best unless close; then allow deterministic variety window
  const result = buildEmptyResult();
  for (const color of COLOR_ORDER) {
    const list = buckets[color] || [];
    const top = pickPreferBestOrVariety(
      list,
      S.pickWindow,
      `${requestedRange}:${color}:primary`,
      S.dominanceMargin
    );
    const others = list.filter((x) => x?.id !== top?.id).slice(0, 6);
    result[color] = { top: top || null, others };
  }

  enforceUniqueTops(result);

  const filledBy = Object.create(null);
  const filledStage = Object.create(null);

  for (const c of COLOR_ORDER) {
    if (result[c]?.top) {
      filledBy[c] = "top_tracks";
      filledStage[c] = "top_tracks";
    }
  }

  let usedIds = getUsedAlbumIds(result);
  const missingColors = () => COLOR_ORDER.filter((c) => !result[c]?.top);

  // 2) Saved albums backfill
  for (const color of missingColors()) {
    try {
      const savedPick = await findSavedAlbumBackfillForColor(accessToken, color, usedIds, {
        maxToScan: S.savedScan,
        minConf: S.minConf,
      });
      if (savedPick) {
        result[color] = { top: savedPick, others: [] };
        usedIds.add(savedPick.id);
        filledBy[color] = "saved";
        filledStage[color] = "saved_albums";
      }
    } catch {}
  }

  // 3) Top artists albums backfill
  for (const color of missingColors()) {
    try {
      const artistPick = await findArtistBackfillForColor(accessToken, color, usedIds, {
        topArtistsN: S.topArtistsN,
        albumsPerArtist: S.albumsPerArtist,
        candidateCap: S.candidateCap,
        minConf: S.minConf,
      });
      if (artistPick) {
        result[color] = { top: artistPick, others: [] };
        usedIds.add(artistPick.id);
        filledBy[color] = "artist";
        filledStage[color] = "top_artists";
      }
    } catch {}
  }

  // 4) Widen search (prefer staying inside requested timeframe first)
  if (missingColors().length) {
    // 4a) deeper saved albums (looser threshold)
    for (const color of missingColors()) {
      try {
        const savedPick = await findSavedAlbumBackfillForColor(accessToken, color, usedIds, {
          maxToScan: S.savedScanWide,
          minConf: S.minConfWide,
        });
        if (savedPick) {
          result[color] = { top: savedPick, others: [] };
          usedIds.add(savedPick.id);
          filledBy[color] = "saved_wide";
          filledStage[color] = "widened_saved";
        }
      } catch {}
    }

    // 4b) deeper top artists (looser threshold)
    for (const color of missingColors()) {
      try {
        const artistPick = await findArtistBackfillForColor(accessToken, color, usedIds, {
          topArtistsN: S.topArtistsN + 4,
          albumsPerArtist: S.albumsPerArtist + 6,
          candidateCap: S.candidateCap + 80,
          minConf: S.minConfWide,
        });
        if (artistPick) {
          result[color] = { top: artistPick, others: [] };
          usedIds.add(artistPick.id);
          filledBy[color] = "artist_wide";
          filledStage[color] = "widened_artists";
        }
      } catch {}
    }

    // 4c) deep top-tracks: requested range FIRST (deeper), then other ranges LIGHTER
    if (missingColors().length) {
      try {
        const widePool = [];

        // requested range first (deeper)
        const reqCands = await gatherTopTrackCandidates(accessToken, requestedRange, {
          pages: S.topTrackPagesWide + 2,
          pageSize: 50,
          maxUnique: 340,
          timeWeight: 1.0,
        });
        widePool.push(...reqCands.map((a) => ({ ...a, source: `wide_req_${requestedRange}` })));

        // then other ranges lighter
        for (const r of allRanges.filter((r) => r !== requestedRange)) {
          const cands = await gatherTopTrackCandidates(accessToken, r, {
            pages: 2,
            pageSize: 50,
            maxUnique: 240,
            timeWeight: 0.55,
          });
          widePool.push(...cands.map((a) => ({ ...a, source: `wide_other_${r}` })));
        }

        // first enrich chunk
        const FIRST_ENRICH = Math.min(S.firstEnrich, widePool.length);
        await enrichWithDominant(widePool.slice(0, FIRST_ENRICH), 6);

        // bucket-perfect (minConfWide)
        for (const color of missingColors()) {
          const pick = pickBestMatchingFromPool(widePool, color, usedIds, S.minConfWide);
          if (pick) {
            const out = { ...pick, source: "wide_top_tracks_backfill" };
            result[color] = { top: out, others: [] };
            usedIds.add(out.id);
            filledBy[color] = "wide_top_tracks";
            filledStage[color] = "widened_top_tracks";
          }
        }

        // batch-enrich deeper and allow ultra-loose + nearest hue
        let idx = FIRST_ENRICH;
        const BATCH = S.enrichBatch;
        const MAX_TOTAL = Math.min(S.maxTotalEnrich, widePool.length);

        while (missingColors().length && idx < MAX_TOTAL) {
          await enrichMoreIfNeeded(widePool, idx, BATCH, 6);
          idx += BATCH;

          // try bucket match with no confidence cutoff
          for (const color of missingColors()) {
            const pick = pickBestMatchingFromPool(widePool, color, usedIds, 0.0);
            if (pick) {
              const out = { ...pick, source: "ultra_loose_bucket_backfill" };
              result[color] = { top: out, others: [] };
              usedIds.add(out.id);
              filledBy[color] = "ultra_loose_bucket";
              filledStage[color] = "ultra_loose_bucket";
            }
          }

          // nearest hue (even very low confidence)
          for (const color of missingColors()) {
            const closest = pickClosestMatch(widePool, color, usedIds);
            if (closest) {
              const out = { ...closest, source: "closest_match_backfill" };
              result[color] = { top: out, others: [] };
              usedIds.add(out.id);
              filledBy[color] = "closest_match";
              filledStage[color] = "closest_match";
            }
          }
        }

        // final pass nearest hue
        for (const color of missingColors()) {
          const closest = pickClosestMatch(widePool, color, usedIds);
          if (closest) {
            const out = { ...closest, source: "closest_match_backfill" };
            result[color] = { top: out, others: [] };
            usedIds.add(out.id);
            filledBy[color] = "closest_match";
            filledStage[color] = "closest_match";
          }
        }
      } catch {}
    }
  }

  // 5) LAST resort: other time ranges (only if still missing)
  const otherRanges = allRanges.filter((r) => r !== requestedRange);
  if (missingColors().length && otherRanges.length) {
    try {
      const pool = [];
      for (const r of otherRanges) {
        const trWeight = r === "short_term" ? 0.6 : r === "medium_term" ? 0.55 : 0.5;
        const cands = await gatherTopTrackCandidates(accessToken, r, {
          pages: 2,
          pageSize: 50,
          maxUnique: 260,
          timeWeight: trWeight,
        });
        pool.push(...cands.map((a) => ({ ...a, source: `other_range_${r}` })));
      }

      await enrichWithDominant(pool.slice(0, 420), 6);

      for (const color of missingColors()) {
        const pick = pickBestMatchingFromPool(pool, color, usedIds, 0.0);
        const chosen = pick || pickClosestMatch(pool, color, usedIds);
        if (chosen) {
          const out = { ...chosen, source: "other_time_range_last_resort" };
          result[color] = { top: out, others: [] };
          usedIds.add(out.id);
          filledBy[color] = "other_time_ranges_last";
          filledStage[color] = "other_time_ranges_last";
        }
      }
    } catch {}
  }

  enforceUniqueTops(result);

  return {
    analyzed: limited.length,
    result,
    meta: {
      method: "bundle_ready_v5_variety_when_close_nearest_hue_low_conf_no_1track",
      dominance_cap: DOMINANCE_CAP,
      time_range: requestedRange,
      strictness: S,
      backfilled_colors: COLOR_ORDER.filter(
        (c) => filledStage[c] && filledStage[c] !== "top_tracks"
      ),
      backfilled_by: filledBy,
      backfilled_stage: filledStage,
      uniqueness: "enforced_by_album_id",
    },
  };
}

/**
 * endpoints
 */
app.get("/api/results", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);

    const requested = (req.query.time_range || "").toString();
    const isSingleRange =
      requested === "short_term" || requested === "medium_term" || requested === "long_term";

    const range = isSingleRange ? requested : "short_term";

    const out = await computeResultsForRange(accessToken, range, limit, {
      allRanges: ["short_term", "medium_term", "long_term"],
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/results_bundle", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);
    const allRanges = ["short_term", "medium_term", "long_term"];

    const [short_term, medium_term, long_term] = await Promise.all([
      computeResultsForRange(accessToken, "short_term", limit, { allRanges }),
      computeResultsForRange(accessToken, "medium_term", limit, { allRanges }),
      computeResultsForRange(accessToken, "long_term", limit, { allRanges }),
    ]);

    res.json({ short_term, medium_term, long_term });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Dominant color extraction
 */
async function getDominantFromImage(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const imgRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) {
    const fail = { hex: null, confidence: 0 };
    cacheSet(url, fail);
    return fail;
  }

  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { data, info } = await sharp(buffer)
    .resize(50, 50, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const totalPixels = Math.floor(data.length / channels);

  let rSum = 0,
    gSum = 0,
    bSum = 0;
  let usedPixels = 0;
  let sSum = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels === 4 ? data[i + 3] : 255;

    if (a < 10) continue;

    rSum += r;
    gSum += g;
    bSum += b;
    usedPixels += 1;

    const { s } = rgbToHsv(r, g, b);
    sSum += s;
  }

  if (usedPixels === 0) {
    const fail = { hex: null, confidence: 0 };
    cacheSet(url, fail);
    return fail;
  }

  const r = Math.round(rSum / usedPixels);
  const g = Math.round(gSum / usedPixels);
  const b = Math.round(bSum / usedPixels);

  const hex = rgbToHex(r, g, b);

  const coverage = usedPixels / Math.max(1, totalPixels);
  const avgSat = sSum / usedPixels;
  const satScore = Math.min(1, avgSat / 0.25);
  const confidence = Math.max(0, Math.min(1, 0.6 * coverage + 0.4 * satScore));

  const out = { hex, confidence };
  cacheSet(url, out);
  return out;
}

function rgbToHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// ✅ less strict bucket thresholds (more options)
function hexToSimpleBucket(hex) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, v } = rgbToHsv(r, g, b);

  if (v < 0.14) return "black";
  if (v > 0.9 && s < 0.1) return "white";
  if (s < 0.18) return "grey";

  if (h >= 330 || h < 15) return "red";
  if (h < 45) return "orange";
  if (h < 75) return "yellow";
  if (h < 160) return "green";
  if (h < 250) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const n = parseInt(clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : d / max;
  const v = max;

  return { h, s, v };
}

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

app.post("/logout", (req, res) => {
  res.clearCookie("access_token", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running: http://127.0.0.1:${PORT}`);
});

// ✅ Proxy Spotify/SpotifyCDN images so canvas downloads work (avoids CORS-tainted canvas)
app.get("/api/proxy_image", async (req, res) => {
  try {
    const raw = (req.query.url || "").toString();
    if (!raw) return res.status(400).send("Missing url");

    let u;
    try {
      u = new URL(raw);
    } catch {
      return res.status(400).send("Invalid url");
    }

    // SSRF safety: only allow Spotify image CDNs
    const host = u.hostname.toLowerCase();
    const allowed =
      host.endsWith(".scdn.co") ||
      host.endsWith(".spotifycdn.com") ||
      host.endsWith("i.scdn.co");

    if (!allowed) return res.status(403).send("Host not allowed");

    const imgRes = await fetch(u.toString(), {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!imgRes.ok) return res.status(502).send("Upstream image fetch failed");

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", contentType);

    const buf = Buffer.from(await imgRes.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).send(String(e));
  }
});