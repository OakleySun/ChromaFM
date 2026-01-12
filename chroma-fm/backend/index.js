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
    <h2>Top Albums (derived)</h2>
    <pre>${escapeHtml(JSON.stringify(albums, null, 2))}</pre>
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
// Fetch top tracks
const topRes = await fetch("https://api.spotify.com/v1/me/top/tracks?limit=50", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
const top = await topRes.json();

// Build album frequency map
const albumMap = {};

for (const track of top.items) {
  const album = track.album;
  if (!albumMap[album.id]) {
    albumMap[album.id] = {
      id: album.id,
      name: album.name,
      artist: album.artists.map(a => a.name).join(", "),
      image: album.images[0]?.url,
      count: 0,
    };
  }
  albumMap[album.id].count += 1;
}

// Convert to sorted list
const albums = Object.values(albumMap)
  .sort((a, b) => b.count - a.count);
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