# 🎨 ChromaFM
> Spotify Wrapped reimagined as a color palette.

**ChromaFM** is a full-stack web application that transforms Spotify listening data into a **color-driven visual profile of a user’s music taste**.  
Instead of simply displaying the user's stats and rankings, ChromaFM analyzes album artwork colors and displays the user’s **favorite albums per color category**, producing both an interactive grid and a **shareable image export for easy sharing**.

---

## ✨ What ChromaFM Does

- Authenticates users via **Spotify OAuth**
- Fetches listening data such as top artists and tracks across multiple **time ranges**
- Extracts dominant colors from album artwork
- Assigns albums to perceptual **color buckets**
- Uses intelligent fallback logic to ensure **complete results**
- Generates a **1080×1920 shareable image** designed for sharing on social platforms such as TikTok and Instagram

---

## Demonstration

**1. Securely login with Spotify (No password needed!)**
<p align="center">
  <img src="https://github.com/user-attachments/assets/6015f48a-17c2-44ef-b628-ef2c6874bb54" width="80%" />
</p>

**2. After a few seconds of waiting, color coded top albums are ready**
<p align="center">
  <img src="https://github.com/user-attachments/assets/cea63947-dccb-4c37-b25a-1c83bf87b92d" width="80%" />
</p>

**3. Flip through your top albums by time frame with the buttons at the top right**
<p align="center">
  <img src="https://github.com/user-attachments/assets/648a4f5d-c135-4668-b5f6-e390eb3b496c" width="80%" />
</p>

**4. If you want to share your results, press Download Image to get a clean shareable picture**
<p align="center">
  <img src="https://github.com/user-attachments/assets/e7367e95-d63a-4bd7-86b9-c40560ac7c35" width="80%" />
</p>

**Three examples of exported pictures:**
<p align="center">
  <img src="https://github.com/user-attachments/assets/cde9c75b-3819-409f-a8cb-ebf2b1a1c115" width="30%" />
  <img src="https://github.com/user-attachments/assets/155f7cd4-0d0b-4189-b715-fd954c730d8b" width="30%" />
  <img src="https://github.com/user-attachments/assets/1d595515-bd30-415a-bdc2-422ce20e2176" width="30%" />
</p>

---

## 🧠 How the Algorithm Works
### 1. Data Collection (Spotify API)
ChromaFM retrieves:
- User top tracks (`short_term`, `medium_term`, `long_term`)
- Saved albums from the user’s library
- Top artists and their albums

---

### 2. Color Extraction
Each album’s artwork is analyzed to extract a dominant hex color, which is mapped into one of 10 buckets:


These buckets are:
- Ordered for visual consistency
- Deterministic
- Guaranteed to be filled via fallback logic

---

### 3. Scoring & Ranking
Spotify's API is not able to give the user's top albums. Therefor, I had to think of an algorithm to determine the user's favorite albums, while still including a lot of variety.

Albums are ranked using a weighted scoring system that considers:
1. User Top Tracks (selected time range)
Uses albums from the user’s most-played tracks for the chosen time window. Spotify's API only give the user's top 50 tracks.
This is the strongest and most accurate signal of current listening behavior.

2. Saved Albums
Falls back to albums the user has explicitly saved, expanding coverage beyond recent listening.

3. Albums from Top Artists
Uses albums from the user’s top artists to infer taste when direct listening data is limited.

4. Cross-Time-Range Fallback
Finally, if a bucket is still empty, ChromaFM checks other time ranges in a deterministic order
(e.g. short-term → medium-term → long-term) to guarantee completeness.

This produces results that feel both **personal** and **stable**, preventing:
- Empty color buckets
- Duplicate albums across colors
- Inconsistent or fragile results

## 🏗️ Architecture

### Frontend
- React
- Canvas API

### Backend
- Node.js + Express
- Spotify Web API
- OAuth session handling

---

# Run ChromaFM locally

### Unfortunately due to Spotify's latest update to their API, Spotify applications created in Development Mode are restricted to 25 users. Additionally, the app owner must manually add the user's email in the dashboard beforehand. Any email not on the list will not be able to sign in, which is why I cannot host ChromaFM online.

Follow these steps if you still want to try it out for yourself.

1. Prereqs
Node.js
A Spotify Developer Account

Go to the Spotify Developer dashboard:
https://developer.spotify.com/dashboard
Press create app
Name it anything you want

Make sure the **Redirect URL** is **http://127.0.0.1:8000/auth/callback**

Take note and copy the client ID and Secret

2. Clone this repo
3. Go to **vite.config.js** and replace everything with this:
```
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
```
Go to the **backend** folder and create a **.env** file
Copy and paste these lines:
```
# Backend server port
PORT=8000
# Spotify Developer App credentials
SPOTIFY_CLIENT_ID=X
SPOTIFY_CLIENT_SECRET=Y
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/auth/callback
```
Replacing X with your client ID and Y with your secret you got in step 1

4. In the terminal, do:
`cd backend
npm install`
`cd ../frontend
npm install`

5. Start the app by doing
```
cd backend
npm run dev
```
and
```
cd frontend
npm run dev
```
in two terminals

6. Finally, go to http://127.0.0.1:5173/ to open ChromaFM

### Always feel free to reach out if there are any issues or cofusuion
### Additionally, you can message me on Linkedin or Email and I can add your email to the dashboard and send pictures of your stats (no Spotify login details required)

## 🔐 Performance & Safety

- Request-level caching to avoid Spotify rate limits
- In-flight deduplication to prevent request storms
- Strict proxy allow-listing (Spotify CDN only)
- Stateless client rendering

---

## 🚀 Future Ideas

- Multi-user palette comparisons
- Cycle through your other top ablums within the color
- Export themes
