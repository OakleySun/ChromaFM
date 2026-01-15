import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";

const ORDER = [
  "white",
  "grey",
  "black",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
];

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

function titleCase(color) {
  return color === "grey" ? "Grey" : color.charAt(0).toUpperCase() + color.slice(1);
}

function parseHex(hex) {
  if (!hex || typeof hex !== "string") return null;
  const h = hex.trim().replace("#", "");
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function srgbToLin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function pickTextColor(bgHex) {
  const rgb = parseHex(bgHex);
  if (!rgb) return "#F3F3F3";
  const R = srgbToLin(rgb.r);
  const G = srgbToLin(rgb.g);
  const B = srgbToLin(rgb.b);
  const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  return L > 0.58 ? "#0E0E0E" : "#F3F3F3";
}

function preloadImagesFromBundle(bundle) {
  try {
    const urls = new Set();
    for (const tr of ["short_term", "medium_term", "long_term"]) {
      const result = bundle?.[tr]?.result;
      if (!result) continue;
      for (const color of ORDER) {
        const top = result?.[color]?.top;
        if (top?.image) urls.add(top.image);
      }
    }
    urls.forEach((u) => {
      const img = new Image();
      img.decoding = "async";
      img.loading = "eager";
      img.src = u;
    });
  } catch {}
}

function getTopFrom(bundle, timeRange, color) {
  const data = bundle?.[timeRange];
  const result = data?.result || data?.buckets || null;
  const top =
    result?.[color]?.top ?? (Array.isArray(result?.[color]) ? result[color][0] : null);
  return top || null;
}

function getTopWithCrossTimeFallback(bundle, timeRange, color) {
  const order =
    timeRange === "short_term"
      ? ["short_term", "medium_term", "long_term"]
      : timeRange === "medium_term"
      ? ["medium_term", "short_term", "long_term"]
      : ["long_term", "medium_term", "short_term"];

  for (const tr of order) {
    const top = getTopFrom(bundle, tr, color);
    if (top) return { top: { ...top }, fromRange: tr };
  }
  return { top: null, fromRange: null };
}

// ---------- SHARE IMAGE GENERATOR (1080x1920) ----------

function timeRangeLabel(tr) {
  if (tr === "short_term") return "Last 4 weeks";
  if (tr === "medium_term") return "Last 6 months";
  return "All time";
}

function hexOrFallback(top, color) {
  return top?.hex || BUCKET_BORDER[color] || "#111111";
}

function proxyUrl(url) {
  return `${API_BASE}/api/proxy_image?url=${encodeURIComponent(url)}`;
}

async function loadImageBitmapViaProxy(url) {
  const res = await fetch(proxyUrl(url));
  if (!res.ok) throw new Error("image fetch failed");
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  return bmp;
}

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

function drawCoverContain(ctx, bmp, x, y, size) {
  const iw = bmp.width;
  const ih = bmp.height;
  const scale = Math.min(size / iw, size / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (size - dw) / 2;
  const dy = y + (size - dh) / 2;
  ctx.drawImage(bmp, dx, dy, dw, dh);
}

function ellipsize(ctx, text, maxWidth) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + "…").width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s.length ? s + "…" : "";
}

async function buildStoryPng({ tiles, timeRange }) {
  // Story size
  const W = 1080;
  const H = 1920;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // ---------- helpers (local to this function) ----------
  function timeRangeLabel(tr) {
    if (tr === "short_term") return "Last 4 weeks";
    if (tr === "medium_term") return "Last 6 months";
    return "All time";
  }

  function hexOrFallback(top, color) {
    return top?.hex || BUCKET_BORDER[color] || "#111111";
  }

  function fitOneLineText(ctx, text, maxWidth, startPx, minPx) {
    let size = startPx;
    ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    while (size > minPx && ctx.measureText(text).width > maxWidth) {
      size -= 1;
      ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    }
    return size;
  }

  function ellipsize(ctx, text, maxWidth) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    let s = text;
    while (s.length > 0 && ctx.measureText(s + "…").width > maxWidth) {
      s = s.slice(0, -1);
    }
    return s.length ? s + "…" : "";
  }

  // ✅ NEW: if it doesn't fit at min font, split into 2 lines ONLY at spaces
  function splitIntoLinesAtSpaces(ctx, text, maxWidth, fontPx, maxLines) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;

    ctx.font = `800 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;

    const lines = [];
    let current = "";

    for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) {
        current = test;
        } else {
        if (current) lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) break;
        }
    }

    if (current && lines.length < maxLines) lines.push(current);

    return lines.length ? lines : null;
  }

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

  function drawCoverContain(ctx, bmp, x, y, size) {
    const iw = bmp.width;
    const ih = bmp.height;
    const scale = Math.min(size / iw, size / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = x + (size - dw) / 2;
    const dy = y + (size - dh) / 2;
    ctx.drawImage(bmp, dx, dy, dw, dh);
  }

  // ---------- background ----------
  ctx.fillStyle = "#0e0e0e";
  ctx.fillRect(0, 0, W, H);

  // ---------- layout ----------
  const pad = 64;
  const headerH = 220;

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

  // ---------- header ----------
  ctx.fillStyle = "#f3f3f3";
  ctx.font = "800 72px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("ChromaFM", pad, pad + 72);

  ctx.fillStyle = "rgba(243,243,243,0.8)";
  ctx.font = "500 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("A colorful way to view your favorite albums.", pad, pad + 132);

  ctx.fillStyle = "rgba(243,243,243,0.8)";
  ctx.font = "500 34px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(timeRangeLabel(timeRange), pad, pad + 192);

  // ---------- preload cover bitmaps ----------
  const coverBitmaps = await Promise.all(
    tiles.map(async (t) => {
      if (!t?.top?.image) return null;
      try {
        return await loadImageBitmapViaProxy(t.top.image);
      } catch {
        return null;
      }
    })
  );

  // ---------- tiles ----------
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = gridLeft + col * (cellW + gap);
    const y = gridTop + row * (cellH + gap);

    const bg = hexOrFallback(t.top, t.color);
    const border = BUCKET_BORDER[t.color] || "#ffffff";
    const fg = pickTextColor(bg);

    // tile background (sharp)
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

    // tighter padding to leave less gaps
    const inPad = 18;
    const gapX = 16;

    const innerX = x + inPad;
    const innerY = y + inPad;
    const innerW = cellW - inPad * 2;
    const innerH = cellH - inPad * 2;

    // bigger cover
    const coverSize = Math.min(innerH * 0.92, innerW * 0.64);
    const coverX = innerX;
    const coverY = innerY + (innerH - coverSize) / 2;

    const textX = coverX + coverSize + gapX;
    const textW = innerX + innerW - textX;

    // cover outline only
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(coverX, coverY, coverSize, coverSize);

    const bmp = coverBitmaps[i];
    if (bmp) {
      // 100% visible cover (contain); no bars added (tile bg shows through)
      drawCoverContain(ctx, bmp, coverX, coverY, coverSize);
    }

    // -------- title + artist + hex on the right --------
    const name = t.top?.name || "No album";
    const artist = t.top?.artist || "";

    ctx.fillStyle = fg;

    const titleStart = 34;
    const titleMin = 18;

    // Try 1-line scale first
    const titlePx = fitOneLineText(ctx, name, textW, titleStart, titleMin);

    const baseTitleY = coverY + 40;

    // If still too wide at min size, wrap to 2 lines at spaces
    ctx.font = `800 ${titlePx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    const needsWrap = ctx.measureText(name).width > textW && titlePx === titleMin;

    let titleLineCount = 1;
    let usedTitlePx = titlePx;

    if (needsWrap) {
      // Ensure we're measuring at min size
      usedTitlePx = titleMin;

      const lines = splitIntoLinesAtSpaces(ctx, name, textW, usedTitlePx, 4);

      if (lines) {
        titleLineCount = lines.length;
        ctx.font = `800 ${usedTitlePx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;

        const lineGap = 6;
        for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], textX, baseTitleY + li * (usedTitlePx + lineGap));
      }
        } else {
        // Single-word edge case: fallback to ellipsis
        ctx.font = `800 ${usedTitlePx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
        ctx.fillText(ellipsize(ctx, name, textW), textX, baseTitleY);
      }
    } else {
      ctx.font = `800 ${usedTitlePx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText(ellipsize(ctx, name, textW), textX, baseTitleY);
    }

    // Artist: smaller, lighter
    const artistPx = Math.max(18, Math.min(24, Math.floor(usedTitlePx * 0.72)));
    const artistY = baseTitleY + (titleLineCount - 1) * (usedTitlePx + 6) + 40;

    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.font = `650 ${artistPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillText(ellipsize(ctx, artist, textW), textX, artistY);
    ctx.restore();

    // tiny hex under artist
    const hex = t.top?.hex ? String(t.top.hex) : "";
    if (hex) {
      const hexY = artistY + 32;
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.font = "600 20px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillStyle = fg;
      ctx.fillText(ellipsize(ctx, hex, textW), textX, hexY);
      ctx.restore();
    }
  }

  return canvas;
}

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

// ------------------------------------------------------

export default function App() {
  const [bundle, setBundle] = useState(null);
  const [timeRange, setTimeRange] = useState("short_term");
  const [error, setError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const isLoggedOut =
    !!error && (error.includes("Not logged in") || error.includes("401"));

  const didHydrateFromCache = useRef(false);

  async function loadBundle({ background = false } = {}) {
    try {
      if (background) setIsRefreshing(true);
      setError("");

      const res = await fetch(`${API_BASE}/api/results_bundle`, {
        credentials: "include",
      });

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON from backend (${res.status}): ${text.slice(0, 160)}`);
      }

      if (!res.ok) throw new Error(json.error || "Failed to load results bundle");

      setBundle(json);
      sessionStorage.setItem("chromafm_bundle_v1", JSON.stringify(json));
      preloadImagesFromBundle(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsRefreshing(false);
    }
  }

async function logout() {
  try {
    await fetch(`${API_BASE}/logout`, {
      method: "POST",
      credentials: "include",
    });
  } finally {
    setBundle(null);
    setError("Not logged in");
    sessionStorage.removeItem("chromafm_bundle_v1");
  }
}

  useEffect(() => {
    if (!didHydrateFromCache.current) {
      didHydrateFromCache.current = true;
      const cached = sessionStorage.getItem("chromafm_bundle_v1");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          setBundle(parsed);
          preloadImagesFromBundle(parsed);
          loadBundle({ background: true });
          return;
        } catch {}
      }
    }
    loadBundle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasResult = !!(bundle?.[timeRange]?.result);

  const tiles = useMemo(() => {
    if (!bundle) return [];
    return ORDER.slice(0, 10).map((color) => {
      const { top, fromRange } = getTopWithCrossTimeFallback(bundle, timeRange, color);
      return { color, top, fromRange };
    });
  }, [bundle, timeRange]);

  async function onDownloadStory() {
    try {
      if (!hasResult) return;
      setIsExporting(true);

      const canvas = await buildStoryPng({ tiles, timeRange });
      const fname = `chromafm-${timeRange}-${Date.now()}.png`;
      downloadCanvasPng(canvas, fname);
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
              onClick={onDownloadStory}
              type="button"
              disabled={!hasResult || isExporting}
              style={{ opacity: !hasResult ? 0.5 : 1 }}
              title={!hasResult ? "Log in and load albums first" : "Download 1080×1920 story"}
            >
              {isExporting ? "Exporting…" : "Download Story"}
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
            {tiles.map(({ color, top, fromRange }) => {
              const bg = top?.hex || BUCKET_BORDER[color] || "#111111";
              const fg = pickTextColor(bg);
              const border = BUCKET_BORDER[color] || "#FFFFFF";

              return (
                <div
                  key={color}
                  className="tile"
                  style={{
                    background: bg,
                    color: fg,
                    borderColor: border,
                  }}
                >
                  <div className="tileHead">
                    <div className="dot" style={{ background: border }} />
                    <div className="tileTitle">{titleCase(color)}</div>

                    <div className="hex">
                      {top?.hex ? top.hex : ""}

                    </div>
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