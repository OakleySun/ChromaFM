import { useEffect, useState } from "react";

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

export default function App() {
  const [data, setData] = useState(null);
  const [timeRange, setTimeRange] = useState("short_term");
  const [error, setError] = useState("");

    async function load() {
    try {
        setError("");
        setData(null);

        const res = await fetch(`${API_BASE}/api/results?time_range=${timeRange}`, {
        credentials: "include",
        });

        const text = await res.text();
        let json;
        try {
        json = JSON.parse(text);
        } catch {
        throw new Error(`Non-JSON from backend (${res.status}): ${text.slice(0, 160)}`);
        }

        if (!res.ok) throw new Error(json.error || "Failed to load results");
        setData(json);

    } catch (e) {
        setError(String(e));
    }
    }


  async function logout() {
    await fetch("http://127.0.0.1:8000/logout", {
        method: "POST",
        credentials: "include",
    });
    setData(null);
    setError("");
  }


    useEffect(() => {
    if (!error) load();
    }, [timeRange]);

  const result = data?.result || data?.buckets || null; // supports either shape

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ margin: 0 }}>ChromaFM</h1>
      <p style={{ marginTop: 6, opacity: 0.75 }}>Top albums by cover color</p>

      <div style={{ display: "flex", gap: 10, margin: "16px 0" }}>
        <a
            href="http://127.0.0.1:8000/login"
            style={{
                display: "inline-block",
                padding: "8px 12px",
                border: "1px solid #ccc",
                borderRadius: 8,
                textDecoration: "none",
                color: "black",
            }}
            >
            Login with Spotify
        </a>
        <button onClick={load}>Refresh</button>
        <button onClick={logout}>Logout</button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={() => setTimeRange("short_term")}>4 weeks</button>
          <button onClick={() => setTimeRange("medium_term")}>6 months</button>
          <button onClick={() => setTimeRange("long_term")}>All time</button>
        </div>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {!result && !error && <p>Loading…</p>}

      {result && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {ORDER.map((color) => {
            // If your backend returns {result:{color:{top,others}}}
            const top = result[color]?.top ?? (Array.isArray(result[color]) ? result[color][0] : null);

            return (
              <div key={color} style={{ border: "1px solid #ddd", borderRadius: 14, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background:
                        color === "white"
                            ? "#fff"
                            : color === "grey"
                            ? "#999"
                            : color === "black"
                            ? "#000"
                            : color,
                      border: "1px solid #ccc",
                    }}
                  />
                  <h3 style={{ margin: 0 }}>{color === "grey" ? "Grey" : color.charAt(0).toUpperCase() + color.slice(1)}</h3>
                </div>

                {!top ? (
                  <p style={{ opacity: 0.7, marginTop: 12 }}>No album found.</p>
                ) : (
                  <div style={{ marginTop: 12 }}>
                    <img
                      src={top.image}
                      alt={top.name}
                      style={{ width: "100%", borderRadius: 12 }}
                    />
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700 }}>{top.name}</div>
                      <div style={{ opacity: 0.75 }}>{top.artist}</div>
                        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>
                        weight: {top.count}
                        {typeof top.confidence === "number" ? ` • conf ${(top.confidence * 100).toFixed(0)}%` : ""}
                        {top.hex ? ` • ${top.hex}` : ""}
                        </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}