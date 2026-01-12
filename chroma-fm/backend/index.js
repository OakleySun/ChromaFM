import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import sharp from "sharp";

dotenv.config();

const app = express();
app.use(cookieParser());

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
  const scope = "user-top-read"; // lets us fetch top tracks

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope,
    redirect_uri: REDIRECT_URI,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Step 2: Spotify redirects back here with ?code=...
app.get("/auth/callback", async (req, res) => {
try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    // 1) Exchange code -> access token
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
    return res.redirect("/");
  } catch (err) {
    res.status(500).send("Server error: " + escapeHtml(String(err)));
  }
});

app.get("/api/results", async (req, res) => {
  try {
    const accessToken = req.cookies.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not logged in. Go to /login" });

    // 1) Top tracks
    const time_range = (req.query.time_range || "short_term").toString();
    const limit = Math.min(parseInt((req.query.limit || "50").toString(), 10) || 50, 50);

    const topRes = await fetch(
    `https://api.spotify.com/v1/me/top/tracks?limit=${limit}&time_range=${encodeURIComponent(time_range)}`,
    {
        headers: { Authorization: `Bearer ${accessToken}` },
    }
    );

    const top = await topRes.json();
    if (!topRes.ok) return res.status(500).json(top);

    // 2) Derive albums with weights
    const albumMap = {};
    for (const track of top.items || []) {
      const album = track.album;
      if (!album?.id) continue;

      if (!albumMap[album.id]) {
        albumMap[album.id] = {
          id: album.id,
          name: album.name,
          artist: (album.artists || []).map(a => a.name).join(", "),
          image: album.images?.[0]?.url || null,
          count: 0,
        };
      }
      albumMap[album.id].count += 1;
    }
    const albums = Object.values(albumMap).sort((a, b) => b.count - a.count);

    // 3) Add dominant color (do first ~25 to keep it fast)
    const limited = albums.slice(0, 25);
    for (const a of limited) {
      if (!a.image) { a.hex = null; continue; }
      try {
        a.hex = await getDominantHexFromImage(a.image);
      } catch {
        a.hex = null;
      }
    }

    // 4) Bucket by basic color name (simple version)
    const buckets = {
      red: [], orange: [], yellow: [], green: [], blue: [], purple: [], pink: [],
      neutral: [],
      unknown: []
    };

    for (const a of limited) {
      if (!a.hex) { buckets.unknown.push(a); continue; }
      const bucket = hexToSimpleBucket(a.hex);
      buckets[bucket].push(a);
    }

    // sort each bucket by count
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((x, y) => y.count - x.count);
    }

    const result = {};

    for (const [color, list] of Object.entries(buckets)) {
    if (color === "unknown") continue; // optional
    result[color] = {
        top: list[0] || null,
        others: list.slice(1, 5), // up to 4 runner-ups
    };
    }

    res.json({
        analyzed: limited.length,
        result,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function getDominantHexFromImage(url) {
  const imgRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!imgRes.ok) return null;

  const arrayBuffer = await imgRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // shrink image so computation is fast
  const { data, info } = await sharp(buffer)
    .resize(50, 50, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // usually 3 (RGB) or 4 (RGBA)
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels === 4 ? data[i + 3] : 255;

    if (a < 10) continue; // skip nearly transparent
    rSum += r; gSum += g; bSum += b;
    count++;
  }

  if (count === 0) return null;

  const r = Math.round(rSum / count);
  const g = Math.round(gSum / count);
  const b = Math.round(bSum / count);

  return rgbToHex(r, g, b);
}

function rgbToHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function hexToSimpleBucket(hex) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s } = rgbToHsv(r, g, b);

  if (s < 0.15) return "neutral";
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
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
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
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});