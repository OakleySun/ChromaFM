import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";
const CACHE_KEY = "chromafm_bundle";

const ORDER = ["white", "grey", "black", "red", "orange", "yellow", "green", "blue", "purple", "pink"];

// Used for tile borders / fallback colors when we don't have a good album-derived hex.
// This ensures every bucket still has consistent color branding.
const BUCKET_BORDER = {
  white: "#FFFFFF",
  grey: "#9E9E9E",
  black: "#0A0A0A",
  red: "#E53935",
  orange: "#FB8C00",
  yellow: "#FDD835",
  green: "#43A047",
  blue: "#1E88E5",
  purple: "#8E24AA",
  pink: "#EC407A",
};

// This defines the fallback order (ex: short_term falls back to medium_term, then long_term).
const TIME_ORDER = {
  short_term: ["short_term", "medium_term", "long_term"],
  medium_term: ["medium_term", "short_term", "long_term"],
  long_term: ["long_term", "medium_term", "short_term"],
};

/**
 * titleCase(color)
 * - Goal: turn bucket keys into display labels.
 */
function titleCase(color) {
  return color === "grey" ? "Grey" : color.charAt(0).toUpperCase() + color.slice(1);
}

/**
 * parseHex(hex)
 * - Input: "#RRGGBB" or "RRGGBB"
 * - Output: {r,g,b} in 0-255, or null if invalid.
 * - Why: used by pickTextColor to compute luminance.
 */
function parseHex(hex) {
  if (!hex || typeof hex !== "string") return null;
  const h = hex.trim().replace("#", "");
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * srgbToLin(c)
 * - Converts one channel from sRGB space to linear-light space.
 * - Why: correct luminance math requires linear space (not raw 0-255).
 */
function srgbToLin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/**
 * pickTextColor(bgHex)
 * - Goal: choose black or near-white text depending on background brightness.
 * - Uses relative luminance formula:
 *   L = 0.2126*R + 0.7152*G + 0.0722*B (in linear space)
 * - Threshold (0.58) is a design choice: higher = more often dark text.
 */
function pickTextColor(bgHex) {
  const rgb = parseHex(bgHex);
  if (!rgb) return "#F3F3F3";
  const L = 0.2126 * srgbToLin(rgb.r) + 0.7152 * srgbToLin(rgb.g) + 0.0722 * srgbToLin(rgb.b);
  return L > 0.58 ? "#0E0E0E" : "#F3F3F3";
}

/**
 * timeRangeLabel(tr)
 * - Converts API time range keys into UI/export labels.
 */
function timeRangeLabel(tr) {
  if (tr === "short_term") return "Last 4 weeks";
  if (tr === "medium_term") return "Last 6 months";
  return "All time";
}

/**
 * proxyUrl(url)
 * - Your canvas export needs image data that is CORS-safe.
 * - This routes album art through your backend proxy endpoint.
 */
function proxyUrl(url) {
  return `${API_BASE}/api/proxy_image?url=${encodeURIComponent(url)}`;
}

/**
 * loadImageBitmapViaProxy(url)
 * - Fetch the image via backend proxy, then convert to ImageBitmap.
 */
async function loadImageBitmapViaProxy(url) {
  const res = await fetch(proxyUrl(url));
  if (!res.ok) throw new Error("image fetch failed");
  return createImageBitmap(await res.blob());
}

/**
 * preloadImagesFromBundle(bundle)
 * - Prefetches album cover URLs to reduce flicker + speed up rendering.
 * - Uses <img> preloading (browser cache), not canvas bitmaps.
 */
function preloadImagesFromBundle(bundle) {
  try {
    const urls = new Set();
    for (const tr of ["short_term", "medium_term", "long_term"]) {
      const result = bundle?.[tr]?.result;
      if (!result) continue;
      for (const color of ORDER) {
        const u = result?.[color]?.top?.image;
        if (u) urls.add(u);
      }
    }
    for (const u of urls) {
      const img = new Image();
      img.decoding = "async";
      img.loading = "eager";
      img.src = u;
    }
  } catch {}
}

/**
 * getTopFrom(bundle, timeRange, color)
 * - Normalizes backend shape differences:
 *   some versions might return {result}, others {buckets}.
 * - Returns the "top" album object for one bucket, or null.
 */
function getTopFrom(bundle, timeRange, color) {
  const data = bundle?.[timeRange];
  const result = data?.result || data?.buckets || null;
  const bucket = result?.[color];
  // Supports two bucket formats:
  // 1) { top: {...}, others: [...] }
  // 2) [album1, album2, ...] (legacy)
  return bucket?.top ?? (Array.isArray(bucket) ? bucket[0] : null) ?? null;
}

/**
 * getTopWithCrossTimeFallback(bundle, timeRange, color)
 * - If selected timeRange has no album for that color, fall back to other ranges.
 * - Returns { top, fromRange } so UI/export can know where it came from.
 */
function getTopWithCrossTimeFallback(bundle, timeRange, color) {
  for (const tr of TIME_ORDER[timeRange] || TIME_ORDER.short_term) {
    const top = getTopFrom(bundle, tr, color);
    if (top) return { top: { ...top }, fromRange: tr };
  }
  return { top: null, fromRange: null };
}

// ---------- Export (1080x1920) ----------

/**
 * roundRect(ctx, x, y, w, h, r)
 * - Creates a rounded rectangle path on the canvas context.
 * - NOTE: doesn't fill or stroke; it only defines the path.
 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * drawCoverContain(ctx, bmp, x, y, size)
 * - Draws a bitmap inside a square without cropping (contain, not cover).
 * - Computes scale to fit the longer side, centers the result.
 */
function drawCoverContain(ctx, bmp, x, y, size) {
  const scale = Math.min(size / bmp.width, size / bmp.height);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  ctx.drawImage(bmp, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
}

/**
 * ellipsize(ctx, text, maxWidth)
 * - Truncates text to fit a max pixel width, adding "…".
 * - Uses ctx.measureText so it’s accurate for the current font.
 */
function ellipsize(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = String(text);
  while (s.length > 0 && ctx.measureText(s + "…").width > maxWidth) s = s.slice(0, -1);
  return s.length ? s + "…" : "";
}

/**
 * fitOneLineText(ctx, text, maxWidth, startPx, minPx)
 * - Shrinks font size until the string fits in one line.
 * - Returns the final size used (so you can scale related text).
 */
function fitOneLineText(ctx, text, maxWidth, startPx, minPx) {
  let size = startPx;
  while (size > minPx) {
    ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
  return size;
}

/**
 * wrapAtSpaces(ctx, text, maxWidth, fontPx, maxLines)
 * - Simple word-wrapping: builds lines until they exceed width.
 * - Stops at maxLines (prevents huge blocks).
 * - Returns array of lines or null if no words.
 */
function wrapAtSpaces(ctx, text, maxWidth, fontPx, maxLines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  ctx.font = `800 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;

  const lines = [];
  let current = "";

  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : null;
}

/**
 * buildPng({ tiles, timeRange })
 * - Main exporter: renders a 1080x1920 image.
 * - Steps:
 *   1) create canvas + paint background
 *   2) draw header (title + subtitle + time range)
 *   3) compute 2x5 grid layout
 *   4) preload cover bitmaps via proxy 
 *   5) draw each tile (bg color, border, cover, fitted title/artist/hex)
 * - Returns the canvas so caller can download it.
 */
async function buildPng({ tiles, timeRange }) {
  const W = 1080;
  const H = 1920;
  const pad = 64;
  const headerH = 220;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#0e0e0e";
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = "#f3f3f3";
  ctx.font = "800 72px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("ChromaFM", pad, pad + 72);

  ctx.fillStyle = "rgba(243,243,243,0.8)";
  ctx.font = "500 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("A colorful way to view your favorite albums.", pad, pad + 132);
  ctx.fillText(timeRangeLabel(timeRange), pad, pad + 192);

  // grid layout
  const gridTop = pad + headerH;
  const gridLeft = pad;
  const gridRight = W - pad;
  const gridBottom = H - pad;

  const cols = 2;
  const rows = 5;
  const gap = 28;

  const gridW = gridRight - gridLeft;
  const gridH = gridBottom - gridTop;
  const cellW = (gridW - gap * (cols - 1)) / cols;
  const cellH = (gridH - gap * (rows - 1)) / rows;

  // preload covers
  const coverBitmaps = await Promise.all(
    tiles.map(async (t) => {
      const u = t?.top?.image;
      if (!u) return null;
      try {
        return await loadImageBitmapViaProxy(u);
      } catch {
        return null;
      }
    })
  );

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gridLeft + col * (cellW + gap);
    const y = gridTop + row * (cellH + gap);

    const bg = t.top?.hex || BUCKET_BORDER[t.color] || "#111111";
    const border = BUCKET_BORDER[t.color] || "#ffffff";
    const fg = pickTextColor(bg);

    // tile bg
    ctx.save();
    roundRect(ctx, x, y, cellW, cellH, 0);
    ctx.clip();
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, cellW, cellH);
    ctx.restore();

    // border
    ctx.strokeStyle = border;
    ctx.lineWidth = 6;
    ctx.strokeRect(x + 3, y + 3, cellW - 6, cellH - 6);

    // inner layout
    const inPad = 18;
    const gapX = 16;
    const innerX = x + inPad;
    const innerY = y + inPad;
    const innerW = cellW - inPad * 2;
    const innerH = cellH - inPad * 2;

    const coverSize = Math.min(innerH * 0.92, innerW * 0.64);
    const coverX = innerX;
    const coverY = innerY + (innerH - coverSize) / 2;

    const textX = coverX + coverSize + gapX;
    const textW = innerX + innerW - textX;

    // cover outline
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(coverX, coverY, coverSize, coverSize);

    const bmp = coverBitmaps[i];
    if (bmp) drawCoverContain(ctx, bmp, coverX, coverY, coverSize);

    // text
    const name = t.top?.name || "No album";
    const artist = t.top?.artist || "";

    ctx.fillStyle = fg;

    const titleStart = 34;
    const titleMin = 18;
    const baseTitleY = coverY + 40;

    const usedTitlePx = fitOneLineText(ctx, name, textW, titleStart, titleMin);
    const needsWrap = usedTitlePx === titleMin && ctx.measureText(name).width > textW;

    let titleLines = 1;
    if (needsWrap) {
      const lines = wrapAtSpaces(ctx, name, textW, titleMin, 4);
      if (lines) {
        titleLines = lines.length;
        const lineGap = 6;
        for (let li = 0; li < lines.length; li++) {
          ctx.fillText(lines[li], textX, baseTitleY + li * (titleMin + lineGap));
        }
      } else {
        ctx.fillText(ellipsize(ctx, name, textW), textX, baseTitleY);
      }
    } else {
      ctx.fillText(ellipsize(ctx, name, textW), textX, baseTitleY);
    }

    const artistPx = Math.max(18, Math.min(24, Math.floor(usedTitlePx * 0.72)));
    const artistY = baseTitleY + (titleLines - 1) * (usedTitlePx + 6) + 40;

    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.font = `650 ${artistPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillText(ellipsize(ctx, artist, textW), textX, artistY);
    ctx.restore();

    const hex = t.top?.hex ? String(t.top.hex) : "";
    if (hex) {
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.font = "600 20px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = fg;
      ctx.fillText(ellipsize(ctx, hex, textW), textX, artistY + 32);
      ctx.restore();
    }
  }

  return canvas;
}

/**
 * downloadCanvasPng(canvas, filename)
 * - Converts canvas to a Blob, then downloads via temporary <a>.
 * - URL.createObjectURL avoids base64 memory overhead.
 */
function downloadCanvasPng(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}

// ---------- App ----------

export default function App() {
  const [bundle, setBundle] = useState(null);
  const [timeRange, setTimeRange] = useState("short_term");
  const [error, setError] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const didHydrate = useRef(false);

  const isLoggedOut = !!error && (error.includes("Not logged in") || error.includes("401"));
  const hasResult = !!bundle?.[timeRange]?.result;

  async function loadBundle({ background = false } = {}) {
    try {
      if (!background) setError("");
      const res = await fetch(`${API_BASE}/api/results_bundle`, { credentials: "include" });
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON from backend (${res.status}): ${text.slice(0, 160)}`);
      }

      if (!res.ok) throw new Error(json.error || "Failed to load results bundle");

      setBundle(json);
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(json));
      preloadImagesFromBundle(json);
    } catch (e) {
      setError(String(e));
    }
  }

  async function logout() {
    try {
      await fetch(`${API_BASE}/logout`, { method: "POST", credentials: "include" });
    } finally {
      setBundle(null);
      setError("Not logged in");
      sessionStorage.removeItem(CACHE_KEY);
    }
  }

  useEffect(() => {
    if (didHydrate.current) return;
    didHydrate.current = true;

    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setBundle(parsed);
        preloadImagesFromBundle(parsed);
        loadBundle({ background: true });
        return;
      } catch {}
    }
    loadBundle();
  }, []);

  const tiles = useMemo(() => {
    if (!bundle) return [];
    return ORDER.slice(0, 10).map((color) => {
      const { top, fromRange } = getTopWithCrossTimeFallback(bundle, timeRange, color);
      return { color, top, fromRange };
    });
  }, [bundle, timeRange]);

  async function onDownloadPic() {
    try {
      if (!hasResult) return;
      setIsExporting(true);
      const canvas = await buildPng({ tiles, timeRange });
      downloadCanvasPng(canvas, `chromafm-${timeRange}-${Date.now()}.png`);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="appShell">
      <div className="appInner">
        <header className="header">
          <div>
            <h1 className="title">ChromaFM</h1>
            <p className="subtitle">A colorful way to view your favorite albums.</p>
          </div>

          <div className="controls">
            <a className="pill" href={`${API_BASE}/login`}>
              Login with Spotify
            </a>

            <button className="pillBtn" onClick={logout} type="button">
              Logout
            </button>

            <button
              className="pillBtn"
              onClick={onDownloadPic}
              type="button"
              disabled={!hasResult || isExporting}
              style={{ opacity: !hasResult ? 0.5 : 1 }}
              title={!hasResult ? "Log in and load albums first" : "Download a 1080×1920 picture"}
            >
              {isExporting ? "Exporting…" : "Download Picture"}
            </button>

            <div className="range">
              <button
                className={`chip ${timeRange === "short_term" ? "active" : ""}`}
                onClick={() => setTimeRange("short_term")}
                type="button"
              >
                4 weeks
              </button>
              <button
                className={`chip ${timeRange === "medium_term" ? "active" : ""}`}
                onClick={() => setTimeRange("medium_term")}
                type="button"
              >
                6 months
              </button>
              <button
                className={`chip ${timeRange === "long_term" ? "active" : ""}`}
                onClick={() => setTimeRange("long_term")}
                type="button"
              >
                All time
              </button>
            </div>
          </div>

          {error && !isLoggedOut && <div className="error">{error}</div>}
        </header>

        {isLoggedOut && (
          <div className="loading" style={{ opacity: 0.7 }}>
            Log in with Spotify to see your albums.
          </div>
        )}

        {!hasResult && !error && !isLoggedOut && <div className="loading">Loading…</div>}

        {hasResult && (
          <div className="gridFixed">
            {tiles.map(({ color, top }) => {
              const bg = top?.hex || BUCKET_BORDER[color] || "#111111";
              const fg = pickTextColor(bg);
              const border = BUCKET_BORDER[color] || "#FFFFFF";

              return (
                <div
                  key={color}
                  className="tile"
                  style={{ background: bg, color: fg, borderColor: border }}
                >
                  <div className="tileHead">
                    <div className="dot" style={{ background: border }} />
                    <div className="tileTitle">{titleCase(color)}</div>
                    <div className="hex">{top?.hex ? top.hex : ""}</div>
                  </div>

                  <div className="imageWrap">
                    {top?.image ? (
                      <img className="img" src={top.image} alt={top.name} loading="eager" />
                    ) : (
                      <div className="noAlbum">No album</div>
                    )}
                  </div>

                  <div className="meta">
                    {top ? (
                      <>
                        <div className="name" title={top.name}>
                          {top.name}
                        </div>
                        <div className="artist" title={top.artist}>
                          {top.artist}
                        </div>
                      </>
                    ) : (
                      <div className="noAlbumMeta">No album found.</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}