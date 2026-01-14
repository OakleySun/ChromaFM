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

const PORT = process.env.PORT || 4000;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  throw new Error("Missing env vars. Check backend/.env");
}

// Homepage with a simple link
app.get("/", (req, res) => {
  res.send(`
    <h1>ChromaFM</h1>
    <p><a href="/login">Login with Spotify</a></p>
    <p>After login, visit <a href="/api/results">/api/results</a>
  `);
});

// Step 1: redirect user to Spotify authorize page
app.get("/login", (req, res) => {
  // ✅ Add user-library-read so we can read saved albums (/me/albums)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: "user-top-read user-library-read",
    redirect_uri: REDIRECT_URI,
    show_dialog: "true",
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Step 2: Spotify redirects back here with ?code=...
app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    // Exchange code -> access token
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

    const accessToken = tokenData.access_token;

    res.cookie("access_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
    });

    return res.redirect("http://127.0.0.1:5173/");
  } catch (err) {
    res.status(500).send("Server error: " + escapeHtml(String(err)));
  }
});

/**
 * Spotify fetch helpers
 */

// Fetch top tracks for a given time range
async function fetchTopTracks(accessToken, time_range, limit = 50) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?limit=${limit}&time_range=${encodeURIComponent(
      time_range
    )}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error("Spotify top tracks failed: " + JSON.stringify(json));
  return json;
}

// Fetch top artists
async function fetchTopArtists(accessToken, limit = 10) {
  const res = await fetch(`https://api.spotify.com/v1/me/top/artists?limit=${limit}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error("Spotify top artists failed: " + JSON.stringify(json));
  return json;
}

// Fetch albums for a given artist (capped, avoids compilations by default)
async function fetchArtistAlbums(accessToken, artistId, limit = 12) {
  const url =
    `https://api.spotify.com/v1/artists/${artistId}/albums` +
    `?include_groups=album,single&limit=${limit}&market=from_token`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) throw new Error("Artist albums failed: " + JSON.stringify(json));
  return json;
}

// ✅ Fetch saved albums (requires user-library-read)
async function fetchSavedAlbums(accessToken, limit = 50, offset = 0) {
  const res = await fetch(
    `https://api.spotify.com/v1/me/albums?limit=${limit}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error("Saved albums failed: " + JSON.stringify(json));
  return json; // items: [{ added_at, album }]
}

// Normalize album name to merge deluxe/remaster/edition variants
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

// A smooth-ish rank weight (top ranks matter more)
function rankWeight(index, total) {
  const t = total <= 1 ? 1 : index / (total - 1);
  const w = 1 - t;
  return w * w;
}

/**
 * Backfill: use SAVED ALBUMS to find an album cover matching a target color
 * Only used when a bucket is empty.
 */
async function findSavedAlbumBackfillForColor(accessToken, targetColor) {
  const MIN_CONF = 0.35;

  const PAGE_SIZE = 50;
  const MAX_TO_SCAN = 200; // raise if you want, but 200 is usually enough
  const pages = Math.ceil(MAX_TO_SCAN / PAGE_SIZE);

  let best = null;

  for (let p = 0; p < pages; p++) {
    const saved = await fetchSavedAlbums(accessToken, PAGE_SIZE, p * PAGE_SIZE);
    const items = saved.items || [];

    for (const it of items) {
      const album = it?.album;
      if (!album?.id) continue;

      const image = album.images?.[0]?.url || null;
      if (!image) continue;

      try {
        const { hex, confidence } = await getDominantFromImage(image);
        if (!hex || confidence < MIN_CONF) continue;

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
          hex,
          confidence,
        };

        if (!best || candidate.confidence > best.confidence) best = candidate;
      } catch {
        // skip failures
      }
    }

    // Stop early if Spotify says there are no more pages
    if (items.length < PAGE_SIZE) break;
  }

  return best;
}

/**
 * Backfill: use top artists to find an album cover matching a target color
 * Only used when a bucket is empty.
 */
async function findArtistBackfillForColor(accessToken, targetColor) {
  const MIN_CONF = 0.35;

  // Keep this small so we don't spam Spotify
  const TOP_ARTISTS_N = 6;
  const ALBUMS_PER_ARTIST = 10;
  const CANDIDATE_CAP = 50;

  const topArtists = await fetchTopArtists(accessToken, TOP_ARTISTS_N);
  const artists = topArtists.items || [];

  // Collect candidates (dedupe by album id)
  const seenAlbumIds = new Set();
  const candidates = [];

  for (const artist of artists) {
    const albumsRes = await fetchArtistAlbums(accessToken, artist.id, ALBUMS_PER_ARTIST);
    for (const item of albumsRes.items || []) {
      if (!item?.id || seenAlbumIds.has(item.id)) continue;
      seenAlbumIds.add(item.id);

      const image = item.images?.[0]?.url || null;
      if (!image) continue;

      candidates.push({
        id: item.id,
        name: item.name,
        artist: (item.artists || []).map((a) => a.name).join(", "),
        image,
        source: "artist_backfill",
        score: 0,
        count: 0,
      });

      if (candidates.length >= CANDIDATE_CAP) break;
    }
    if (candidates.length >= CANDIDATE_CAP) break;
  }

  let best = null;

  for (const c of candidates) {
    try {
      const { hex, confidence } = await getDominantFromImage(c.image);
      if (!hex || confidence < MIN_CONF) continue;

      const bucket = hexToSimpleBucket(hex);
      if (bucket !== targetColor) continue;

      const enriched = { ...c, hex, confidence };

      if (!best || enriched.confidence > best.confidence) best = enriched;
    } catch {
      // skip failures
    }
  }

  return best; // may be null
}

app.get("/api/results", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);

    const requested = (req.query.time_range || "").toString();
    const isSingleRange =
      requested === "short_term" || requested === "medium_term" || requested === "long_term";

    const ranges = isSingleRange ? [requested] : ["short_term", "medium_term", "long_term"];
    const timeWeights = isSingleRange
      ? { [requested]: 1.0 }
      : { short_term: 1.0, medium_term: 0.6, long_term: 0.3 };

    // Album accumulator keyed by normalized identity (name + primary artist)
    const albumMap = Object.create(null);

    for (const range of ranges) {
      const top = await fetchTopTracks(accessToken, range, limit);
      const items = top.items || [];
      const total = items.length || 1;

      items.forEach((track, index) => {
        const album = track.album;
        if (!album?.id) return;

        const primaryArtistName = album.artists?.[0]?.name || "";
        const normName = normalizeAlbumName(album.name);
        const key = `${normName}::${primaryArtistName.toLowerCase()}`;

        const wRank = rankWeight(index, total);
        const wTime = timeWeights[range] ?? 0.0;
        const score = wRank * wTime;

        if (!albumMap[key]) {
          albumMap[key] = {
            id: album.id,
            name: album.name,
            artist: (album.artists || []).map((a) => a.name).join(", "),
            image: album.images?.[0]?.url || null,
            score: 0,
            appearances: 0,
            count: 0,
          };
        }

        albumMap[key].score += score;
        albumMap[key].appearances += 1;
        albumMap[key].count += 1;
      });
    }

    // Artist reinforcement (small boost for top artists)
    let artistBonus = Object.create(null);
    try {
      const artists = await fetchTopArtists(accessToken, 10);
      const items = artists.items || [];
      items.forEach((a, i) => {
        artistBonus[a.name] = (items.length - i) / 20; // max ~ +0.5
      });
    } catch {
      artistBonus = Object.create(null);
    }

    for (const album of Object.values(albumMap)) {
      const primary = (album.artist || "").split(",")[0].trim();
      if (artistBonus[primary]) album.score += artistBonus[primary];
    }

    // Dominance cap
    const DOMINANCE_CAP = 3.0;

    const albums = Object.values(albumMap)
      .map((a) => ({ ...a, score: Math.min(a.score, DOMINANCE_CAP) }))
      .sort((a, b) => b.score - a.score);

    // Analyze top 25 for colors
    const limited = albums.slice(0, 25);

    // Add dominant color + confidence
    for (const a of limited) {
      if (!a.image) {
        a.hex = null;
        a.confidence = 0;
        continue;
      }
      try {
        const { hex, confidence } = await getDominantFromImage(a.image);

        // ✅ Always keep the hex for TOP-TRACK albums
        a.confidence = confidence;
        a.hex = hex;

        // Optional: flag low-confidence so you can show a badge in UI
        a.low_confidence = confidence < 0.35;
      } catch {
        a.hex = null;
        a.confidence = 0;
      }
    }

    // Buckets (includes white/grey/black)
    const buckets = {
      red: [],
      orange: [],
      yellow: [],
      green: [],
      blue: [],
      purple: [],
      pink: [],
      white: [],
      grey: [],
      black: [],
      unknown: [],
    };

    for (const a of limited) {
      if (!a.hex) {
        buckets.unknown.push(a);
        continue;
      }
      const bucket = hexToSimpleBucket(a.hex);
      (buckets[bucket] || buckets.unknown).push(a);
    }

    // Sort each bucket: score then count
    for (const k of Object.keys(buckets)) {
        buckets[k].sort(
        (x, y) =>
            (y.score - x.score) ||
            ((y.confidence || 0) - (x.confidence || 0)) ||
            (y.count - x.count)
        );
    }

    // Build result (exclude unknown, as before)
    const result = {};
    for (const [color, list] of Object.entries(buckets)) {
      if (color === "unknown") continue;
      result[color] = {
        top: list[0] || null,
        others: list.slice(1, 5),
      };
    }

    // ✅ Backfill empty colors with priority:
    // (1) Saved albums, then (2) Top-artist albums.
    // Never overrides track-derived top.
    const colorsNeedingBackfill = Object.keys(result).filter((c) => !result[c]?.top);
    const filledBy = Object.create(null);

    for (const color of colorsNeedingBackfill) {
      // 1) Try saved albums first
      try {
        const savedPick = await findSavedAlbumBackfillForColor(accessToken, color);
        if (savedPick) {
          result[color] = { top: savedPick, others: [] };
          filledBy[color] = "saved";
          continue;
        }
      } catch {
        // ignore
      }

      // 2) Then try top artists
      try {
        const artistPick = await findArtistBackfillForColor(accessToken, color);
        if (artistPick) {
          result[color] = { top: artistPick, others: [] };
          filledBy[color] = "artist";
        }
      } catch {
        // ignore
      }
    }

    res.json({
      analyzed: limited.length,
      result,
      meta: {
        method: "volt_style_blend_v1_plus_saved_then_artist_color_backfill",
        dominance_cap: DOMINANCE_CAP,
        time_weights: timeWeights,
        backfilled_colors: colorsNeedingBackfill,
        backfilled_by: filledBy,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function getDominantFromImage(url) {
  const imgRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) return { hex: null, confidence: 0 };

  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { data, info } = await sharp(buffer)
    .resize(50, 50, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // 3 or 4
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

  if (usedPixels === 0) return { hex: null, confidence: 0 };

  const r = Math.round(rSum / usedPixels);
  const g = Math.round(gSum / usedPixels);
  const b = Math.round(bSum / usedPixels);

  const hex = rgbToHex(r, g, b);

  const coverage = usedPixels / Math.max(1, totalPixels);
  const avgSat = sSum / usedPixels;
  const satScore = Math.min(1, avgSat / 0.35);

  const confidence = Math.max(0, Math.min(1, 0.65 * coverage + 0.35 * satScore));

  return { hex, confidence };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// HSV thresholds for white/grey/black + colors
function hexToSimpleBucket(hex) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, v } = rgbToHsv(r, g, b);

  if (v < 0.12) return "black";
  if (v > 0.92 && s < 0.08) return "white";
  if (s < 0.15) return "grey";

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
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
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

// tiny helper so JSON doesn't break the HTML page
function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

app.post("/logout", (req, res) => {
  res.clearCookie("access_token");
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running: http://127.0.0.1:${PORT}`);
});