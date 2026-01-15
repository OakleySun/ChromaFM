import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import sharp from "sharp";

dotenv.config();

const app = express();
app.use(cookieParser());

// CORS
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

// ===============================
// Rate-limit defenses (Spotify)
// ===============================
const SPOTIFY_CACHE = new Map(); // key -> { v, t }
const SPOTIFY_INFLIGHT = new Map(); // key -> Promise
const SPOTIFY_CACHE_TTL = 20_000;

function tokenKey(accessToken) {
  return accessToken ? accessToken.slice(-12) : "no_token";
}

function spotifyCacheGet(key) {
  const hit = SPOTIFY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > SPOTIFY_CACHE_TTL) {
    SPOTIFY_CACHE.delete(key);
    return null;
  }
  return hit.v;
}

function spotifyCacheSet(key, value) {
  SPOTIFY_CACHE.set(key, { v: value, t: Date.now() });
  if (SPOTIFY_CACHE.size > 2500) {
    SPOTIFY_CACHE.delete(SPOTIFY_CACHE.keys().next().value);
  }
}

async function spotifyFetchJson(accessToken, url, cacheKey) {
  const k = `${tokenKey(accessToken)}:${cacheKey}`;

  const cached = spotifyCacheGet(k);
  if (cached) return cached;

  if (SPOTIFY_INFLIGHT.has(k)) return SPOTIFY_INFLIGHT.get(k);

  const p = (async () => {
    const doFetch = () =>
      fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    let res = await doFetch();

    // retry once on 429
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("Retry-After") || "1", 10);
      const waitMs = Math.min(5000, Math.max(200, ra * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
      res = await doFetch();
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `Spotify API failed (${res.status}): ${json ? JSON.stringify(json) : "no-json"}`
      );
    }

    spotifyCacheSet(k, json);
    return json;
  })();

  SPOTIFY_INFLIGHT.set(k, p);
  try {
    return await p;
  } finally {
    SPOTIFY_INFLIGHT.delete(k);
  }
}

// ===============================
// Compute dedupe (refresh storms)
// ===============================
const COMPUTE_CACHE = new Map(); // key -> { v, t }
const COMPUTE_INFLIGHT = new Map(); // key -> Promise
const COMPUTE_TTL = 12_000;

function computeCacheGet(key) {
  const hit = COMPUTE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > COMPUTE_TTL) {
    COMPUTE_CACHE.delete(key);
    return null;
  }
  return hit.v;
}
function computeCacheSet(key, value) {
  COMPUTE_CACHE.set(key, { v: value, t: Date.now() });
  if (COMPUTE_CACHE.size > 120) {
    COMPUTE_CACHE.delete(COMPUTE_CACHE.keys().next().value);
  }
}

// ===============================
// Spotify API wrappers (cached)
// ===============================
async function fetchTopTracks(accessToken, time_range, limit = 50, offset = 0) {
  const url = `https://api.spotify.com/v1/me/top/tracks?limit=${limit}&offset=${offset}&time_range=${encodeURIComponent(
    time_range
  )}`;
  return spotifyFetchJson(accessToken, url, `top_tracks:${time_range}:${limit}:${offset}`);
}

async function fetchTopArtists(accessToken, limit = 10) {
  const url = `https://api.spotify.com/v1/me/top/artists?limit=${limit}`;
  return spotifyFetchJson(accessToken, url, `top_artists:${limit}`);
}

async function fetchArtistAlbums(accessToken, artistId, limit = 12) {
  const url =
    `https://api.spotify.com/v1/artists/${artistId}/albums` +
    `?include_groups=album,single,compilation&limit=${limit}&market=from_token`;
  return spotifyFetchJson(accessToken, url, `artist_albums:${artistId}:${limit}`);
}

async function fetchSavedAlbums(accessToken, limit = 50, offset = 0) {
  const url = `https://api.spotify.com/v1/me/albums?limit=${limit}&offset=${offset}`;
  return spotifyFetchJson(accessToken, url, `saved_albums:${limit}:${offset}`);
}

// ===============================
// Helpers
// ===============================
function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isOneTrackAlbum(albumLike) {
  const t = albumLike?.total_tracks;
  return typeof t === "number" && t <= 1;
}

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

function hashStringToInt(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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
      pickWindow: 6,
      dominanceMargin: 0.32,
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
      pickWindow: 4,
      dominanceMargin: 0.42,
    };
  }
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
    pickWindow: 2,
    dominanceMargin: 0.55,
  };
}

// score-first lock-in decision
function pickPreferBestOrVariety(list, n, key, dominanceMargin = 0.25) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length === 1) return list[0];

  const best = list[0];
  const runnerUp = list[1];

  const bestS = typeof best?.score === "number" ? best.score : 0;
  const upS = typeof runnerUp?.score === "number" ? runnerUp.score : 0;

  if (upS <= 0 || bestS >= upS * (1 + dominanceMargin)) return best;

  const window = Math.max(1, Math.min(n, list.length));
  const idx = hashStringToInt(key) % window;
  return list[idx];
}

// ✅ NEW: appearances override for EVERY color
function getAppearances(a) {
  return typeof a?.appearances === "number" ? a.appearances : 0;
}

/**
 * If the top 2 candidates for a color bucket differ in appearances by >= 2,
 * pick the higher-appearance one. Otherwise fall back to score lock-in + variety.
 */
function pickTopForColor(list, color, n, key, dominanceMargin) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length === 1) return list[0];

  const a0 = list[0];
  const a1 = list[1];

  const d = Math.abs(getAppearances(a0) - getAppearances(a1));
  if (d >= 2) return getAppearances(a0) >= getAppearances(a1) ? a0 : a1;

  return pickPreferBestOrVariety(list, n, key, dominanceMargin);
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

function getUsedAlbumIds(result) {
  const used = new Set();
  for (const c of COLOR_ORDER) {
    const id = result[c]?.top?.id;
    if (id) used.add(id);
  }
  return used;
}

// enforce unique album id across colors (tops only)
function enforceUniqueTops(result) {
  const seen = new Map(); // albumId -> color
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
    } else {
      result[otherColor].top = null;
      result[otherColor].others = [];
      seen.set(id, color);
    }
  }
}

// ===============================
// Dominant color extraction
// ===============================
const DOMINANT_CACHE = new Map();
const DOMINANT_CACHE_MAX = 1200;

function dominantCacheGet(key) {
  return DOMINANT_CACHE.get(key) || null;
}
function dominantCacheSet(key, value) {
  DOMINANT_CACHE.set(key, value);
  if (DOMINANT_CACHE.size > DOMINANT_CACHE_MAX) {
    DOMINANT_CACHE.delete(DOMINANT_CACHE.keys().next().value);
  }
}

async function getDominantFromImage(url) {
  const cached = dominantCacheGet(url);
  if (cached) return cached;

  const imgRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) {
    const fail = { hex: null, confidence: 0 };
    dominantCacheSet(url, fail);
    return fail;
  }

  const buffer = Buffer.from(await imgRes.arrayBuffer());

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
    dominantCacheSet(url, fail);
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
  dominantCacheSet(url, out);
  return out;
}

function rgbToHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
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

// slightly-looser buckets (more options)
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

// ===============================
// Concurrency helpers
// ===============================
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
      return;
    }
    try {
      const { hex, confidence } = await getDominantFromImage(a.image);
      a.hex = hex;
      a.confidence = confidence;
    } catch {
      a.hex = null;
      a.confidence = 0;
    }
  });
  return albums;
}

async function enrichMoreIfNeeded(pool, startIndex, count) {
  const slice = pool.slice(startIndex, startIndex + count);
  const toEnrich = slice.filter((a) => a && !a.hex && a.image);
  if (!toEnrich.length) return 0;
  await enrichWithDominant(toEnrich, 6);
  return toEnrich.length;
}

// ===============================
// Candidate building
// ===============================
async function gatherTopTrackCandidates(accessToken, timeRange, opts = {}) {
  const { pages = 1, pageSize = 50, maxUnique = 260, timeWeight = 1.0 } = opts;

  const albumMap = Object.create(null);
  const totalApprox = Math.max(1, pages * pageSize);

  for (let p = 0; p < pages; p++) {
    const top = await fetchTopTracks(accessToken, timeRange, pageSize, p * pageSize);
    const items = top.items || [];

    for (let index = 0; index < items.length; index++) {
      const track = items[index];
      const globalIndex = p * pageSize + index;

      const album = track.album;
      if (!album?.id) continue;
      if (isOneTrackAlbum(album)) continue;

      const primaryArtistName = album.artists?.[0]?.name || "";
      const key = `${normalizeAlbumName(album.name)}::${primaryArtistName.toLowerCase()}`;

      const score = rankWeight(globalIndex, totalApprox) * timeWeight;

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
    }

    if (items.length < pageSize) break;
  }

  return Object.values(albumMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxUnique);
}

// ===============================
// Backfills
// ===============================
function pickBestMatchingFromPool(pool, targetColor, usedIds, minConf = 0.2) {
  let best = null;
  for (const a of pool) {
    if (!a?.id || usedIds.has(a.id)) continue;
    if (!a.hex) continue;

    const conf = typeof a.confidence === "number" ? a.confidence : 0;
    if (conf < minConf) continue;

    if (hexToSimpleBucket(a.hex) !== targetColor) continue;

    if (!best || cmpAlbumStrength(a, best) < 0) best = a;
  }
  return best;
}

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
      if (usedIds.has(album.id)) continue;
      if (isOneTrackAlbum(album)) continue;

      const image = album.images?.[0]?.url || null;
      if (!image) continue;

      const { hex, confidence } = await getDominantFromImage(image).catch(() => ({
        hex: null,
        confidence: 0,
      }));
      if (!hex || confidence < MIN_CONF) continue;
      if (hexToSimpleBucket(hex) !== targetColor) continue;

      const candidate = {
        id: album.id,
        name: album.name,
        artist: (album.artists || []).map((a) => a.name).join(", "),
        image,
        total_tracks: album.total_tracks,
        source: "saved",
        score: 0,
        count: 0,
        hex,
        confidence,
      };

      if (!best || candidate.confidence > best.confidence) best = candidate;
    }

    if (items.length < PAGE_SIZE) break;
  }

  return best;
}

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
      if (usedIds.has(item.id)) continue;
      if (seenAlbumIds.has(item.id)) continue;
      if (isOneTrackAlbum(item)) continue;

      const image = item.images?.[0]?.url || null;
      if (!image) continue;

      seenAlbumIds.add(item.id);
      candidates.push({
        id: item.id,
        name: item.name,
        artist: (item.artists || []).map((a) => a.name).join(", "),
        image,
        total_tracks: item.total_tracks,
        source: "artist",
        score: 0,
        count: 0,
      });

      if (candidates.length >= CANDIDATE_CAP) break;
    }
    if (candidates.length >= CANDIDATE_CAP) break;
  }

  let best = null;

  await mapLimit(candidates, 6, async (c) => {
    const { hex, confidence } = await getDominantFromImage(c.image).catch(() => ({
      hex: null,
      confidence: 0,
    }));
    if (!hex || confidence < MIN_CONF) return;
    if (hexToSimpleBucket(hex) !== targetColor) return;

    const enriched = { ...c, hex, confidence };
    if (!best || enriched.confidence > best.confidence) best = enriched;
  });

  return best;
}

// ===============================
// Core compute
// ===============================
async function computeResultsForRange(accessToken, requestedRange, limit, opts = {}) {
  const allRanges =
    Array.isArray(opts.allRanges) && opts.allRanges.length
      ? opts.allRanges
      : ["short_term", "medium_term", "long_term"];

  const S = strictnessForRange(requestedRange);
  const DOMINANCE_CAP = 3.0;

  const cKey = `${tokenKey(accessToken)}:range:${requestedRange}:limit:${limit}`;
  const cached = computeCacheGet(cKey);
  if (cached) return cached;
  if (COMPUTE_INFLIGHT.has(cKey)) return COMPUTE_INFLIGHT.get(cKey);

  const p = (async () => {
    // 1) top tracks (requested range)
    const candidates = await gatherTopTrackCandidates(accessToken, requestedRange, {
      pages: 1,
      pageSize: limit,
      maxUnique: 260,
      timeWeight: 1.0,
    });

    // small bonus for top artists (cached)
    try {
      const artists = await fetchTopArtists(accessToken, 12);
      const aitems = artists.items || [];
      const bonus = Object.create(null);
      aitems.forEach((a, i) => (bonus[a.name] = (aitems.length - i) / 22));

      for (const album of candidates) {
        const primary = (album.artist || "").split(",")[0].trim();
        if (bonus[primary]) album.score += bonus[primary];
      }
    } catch {}

    const limited = candidates
      .map((a) => ({ ...a, score: Math.min(a.score, DOMINANCE_CAP) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 35);

    await enrichWithDominant(limited, 6);

    // bucketize
    const buckets = Object.create(null);
    for (const c of COLOR_ORDER) buckets[c] = [];

    for (const a of limited) {
      if (!a.hex) continue;
      const bucket = hexToSimpleBucket(a.hex);
      buckets[bucket]?.push(a);
    }

    for (const c of COLOR_ORDER) buckets[c].sort((x, y) => cmpAlbumStrength(x, y));

    // pick tops (+ others)
    const result = buildEmptyResult();
    for (const color of COLOR_ORDER) {
      const list = buckets[color] || [];
      const top = pickTopForColor(
        list,
        color,
        S.pickWindow,
        `${requestedRange}:${color}:primary`,
        S.dominanceMargin
      );

      result[color] = {
        top: top || null,
        others: list.filter((x) => x?.id !== top?.id).slice(0, 6),
      };
    }

    enforceUniqueTops(result);

    const usedIds = () => getUsedAlbumIds(result);
    const missing = () => COLOR_ORDER.filter((c) => !result[c]?.top);
    const backfilledBy = Object.create(null);

    // 2) saved
    for (const color of missing()) {
      const pick = await findSavedAlbumBackfillForColor(accessToken, color, usedIds(), {
        maxToScan: S.savedScan,
        minConf: S.minConf,
      }).catch(() => null);

      if (pick) {
        result[color] = { top: pick, others: [] };
        backfilledBy[color] = "saved";
      }
    }

    // 3) artists
    for (const color of missing()) {
      const pick = await findArtistBackfillForColor(accessToken, color, usedIds(), {
        topArtistsN: S.topArtistsN,
        albumsPerArtist: S.albumsPerArtist,
        candidateCap: S.candidateCap,
        minConf: S.minConf,
      }).catch(() => null);

      if (pick) {
        result[color] = { top: pick, others: [] };
        backfilledBy[color] = "artist";
      }
    }

    // 4) widen only if missing >=2
    if (missing().length >= 2) {
      // wider saved
      for (const color of missing()) {
        const pick = await findSavedAlbumBackfillForColor(accessToken, color, usedIds(), {
          maxToScan: S.savedScanWide,
          minConf: S.minConfWide,
        }).catch(() => null);

        if (pick) {
          result[color] = { top: pick, others: [] };
          backfilledBy[color] = "saved_wide";
        }
      }

      // wider artists
      for (const color of missing()) {
        const pick = await findArtistBackfillForColor(accessToken, color, usedIds(), {
          topArtistsN: S.topArtistsN + 4,
          albumsPerArtist: S.albumsPerArtist + 6,
          candidateCap: S.candidateCap + 80,
          minConf: S.minConfWide,
        }).catch(() => null);

        if (pick) {
          result[color] = { top: pick, others: [] };
          backfilledBy[color] = "artist_wide";
        }
      }

      // wide top-tracks pool
      if (missing().length) {
        const widePool = [];

        const reqCands = await gatherTopTrackCandidates(accessToken, requestedRange, {
          pages: S.topTrackPagesWide + 2,
          pageSize: 50,
          maxUnique: 340,
          timeWeight: 1.0,
        });
        widePool.push(...reqCands);

        for (const r of allRanges.filter((r) => r !== requestedRange)) {
          const cands = await gatherTopTrackCandidates(accessToken, r, {
            pages: 2,
            pageSize: 50,
            maxUnique: 240,
            timeWeight: 0.55,
          });
          widePool.push(...cands);
        }

        const FIRST = Math.min(S.firstEnrich, widePool.length);
        await enrichWithDominant(widePool.slice(0, FIRST), 6);

        for (const color of missing()) {
          const pick = pickBestMatchingFromPool(widePool, color, usedIds(), S.minConfWide);
          if (pick) {
            result[color] = { top: { ...pick, source: "wide_top_tracks" }, others: [] };
            backfilledBy[color] = "wide_top_tracks";
          }
        }

        let idx = FIRST;
        const MAX_TOTAL = Math.min(S.maxTotalEnrich, widePool.length);

        while (missing().length && idx < MAX_TOTAL) {
          await enrichMoreIfNeeded(widePool, idx, S.enrichBatch);
          idx += S.enrichBatch;

          for (const color of missing()) {
            const pick = pickBestMatchingFromPool(widePool, color, usedIds(), 0.0);
            if (pick) {
              result[color] = { top: { ...pick, source: "ultra_loose" }, others: [] };
              backfilledBy[color] = "ultra_loose";
            }
          }
        }
      }
    }

    // 5) last resort: other time ranges
    if (missing().length) {
      const pool = [];
      for (const r of allRanges.filter((r) => r !== requestedRange)) {
        const w = r === "short_term" ? 0.6 : r === "medium_term" ? 0.55 : 0.5;
        const cands = await gatherTopTrackCandidates(accessToken, r, {
          pages: 2,
          pageSize: 50,
          maxUnique: 260,
          timeWeight: w,
        });
        pool.push(...cands);
      }

      await enrichWithDominant(pool.slice(0, 420), 6);

      for (const color of missing()) {
        const pick = pickBestMatchingFromPool(pool, color, usedIds(), 0.0);
        if (pick) {
          result[color] = { top: { ...pick, source: "other_ranges_last" }, others: [] };
          backfilledBy[color] = "other_ranges_last";
        }
      }
    }

    enforceUniqueTops(result);

    const out = {
      analyzed: limited.length,
      result,
      meta: {
        method: "bundle_ready_min_app_overrides_all_colors",
        time_range: requestedRange,
        backfilled_colors: COLOR_ORDER.filter((c) => !!backfilledBy[c]),
        backfilled_by: backfilledBy,
      },
    };

    computeCacheSet(cKey, out);
    return out;
  })();

  COMPUTE_INFLIGHT.set(cKey, p);
  try {
    return await p;
  } finally {
    COMPUTE_INFLIGHT.delete(cKey);
  }
}

// ===============================
// Routes
// ===============================
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
          "Basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64"),
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

app.get("/api/results", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);
    const requested = (req.query.time_range || "").toString();
    const range =
      requested === "short_term" || requested === "medium_term" || requested === "long_term"
        ? requested
        : "short_term";

    const out = await computeResultsForRange(accessToken, range, limit, {
      allRanges: ["short_term", "medium_term", "long_term"],
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Debounce bundle per-user (15s)
const BUNDLE_INFLIGHT = new Map(); // tokenKey -> { p, t }

app.get("/api/results_bundle", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);
    const allRanges = ["short_term", "medium_term", "long_term"];

    const tKey = tokenKey(accessToken);
    const now = Date.now();
    const existing = BUNDLE_INFLIGHT.get(tKey);

    if (existing && now - existing.t < 15_000) {
      return res.json(await existing.p);
    }

    const p = (async () => {
      const [short_term, medium_term, long_term] = await Promise.all([
        computeResultsForRange(accessToken, "short_term", limit, { allRanges }),
        computeResultsForRange(accessToken, "medium_term", limit, { allRanges }),
        computeResultsForRange(accessToken, "long_term", limit, { allRanges }),
      ]);
      return { short_term, medium_term, long_term };
    })();

    BUNDLE_INFLIGHT.set(tKey, { p, t: now });

    try {
      res.json(await p);
    } finally {
      setTimeout(() => {
        const cur = BUNDLE_INFLIGHT.get(tKey);
        if (cur && cur.p === p) BUNDLE_INFLIGHT.delete(tKey);
      }, 15_000);
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("access_token", { httpOnly: true, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running: http://127.0.0.1:${PORT}`);
});

// ===============================
// Proxy images (for canvas export)
// ===============================
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

    const host = u.hostname.toLowerCase();
    const allowed =
      host.endsWith(".scdn.co") || host.endsWith(".spotifycdn.com") || host.endsWith("i.scdn.co");
    if (!allowed) return res.status(403).send("Host not allowed");

    const imgRes = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!imgRes.ok) return res.status(502).send("Upstream image fetch failed");

    res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");

    res.send(Buffer.from(await imgRes.arrayBuffer()));
  } catch (e) {
    res.status(500).send(String(e));
  }
});