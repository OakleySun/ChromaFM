import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();

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
    <p>After login, visit <a href="/api/albums">/api/albums</a></p>
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

    // 2) Get top tracks
    const topRes = await fetch(
      "https://api.spotify.com/v1/me/top/tracks?limit=50",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const top = await topRes.json();
    if (!topRes.ok) {
      return res
        .status(500)
        .send("Top tracks error: " + escapeHtml(JSON.stringify(top, null, 2)));
    }

    // 3) Derive top albums (frequency count)
    const albumMap = {};

    for (const track of top.items || []) {
      const album = track.album;
      if (!album?.id) continue;

      if (!albumMap[album.id]) {
        albumMap[album.id] = {
          id: album.id,
          name: album.name,
          artist: (album.artists || []).map((a) => a.name).join(", "),
          image: album.images?.[0]?.url || null,
          count: 0,
        };
      }
      albumMap[album.id].count += 1;
    }

    const albums = Object.values(albumMap).sort((a, b) => b.count - a.count);

    // 4) Show result
    res.send(`
      <h2>Derived Top Albums</h2>
      <p>Count = how many of your top tracks come from that album</p>
      <pre>${escapeHtml(JSON.stringify(albums, null, 2))}</pre>
    `);
  } catch (err) {
    res.status(500).send("Server error: " + escapeHtml(String(err)));
  }
});

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