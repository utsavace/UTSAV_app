import React, { useEffect, useState } from "react";

// ============================================================================
// DivergenceChart — modal with two stacked SVG panels:
//   TOP: price line with divergence trendlines drawn between the two pivots
//   BOTTOM: RSI(14) with the SAME divergence drawn on the RSI values
// Green = bullish divergence, Red = bearish. ▲/▼ marker on the confirm bar.
// ============================================================================

interface ChartEvent {
  type: "bullish" | "bearish";
  confirmDate: string;
  p1: { x: number; d: string; price: number; rsi: number };
  p2: { x: number; d: string; price: number; rsi: number };
  confirmX: number;
}
interface ChartData {
  ok: boolean;
  symbol: string;
  dates: string[];
  closes: number[];
  highs: number[];
  lows: number[];
  rsi: number[];
  events: ChartEvent[];
  error?: string;
}

const GREEN = "#22c55e", RED = "#ef4444", GRID = "#1b2230", TEXT = "#8e9ba9";

export function DivergenceChart({ symbol, name, asOf, onClose }: { symbol: string; name?: string; asOf?: string | null; onClose: () => void }) {
  const [data, setData] = useState<ChartData | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/divergence/chart?symbol=${encodeURIComponent(symbol)}${asOf ? `&asOf=${asOf}` : ""}&t=${Date.now()}`)
      .then((r) => r.json())
      .then((d) => (d.ok ? setData(d) : setErr(d.error || "Chart load nahi hua")))
      .catch(() => setErr("Chart load nahi hua — server dekho"));
  }, [symbol, asOf]);

  const W = 920, PH = 330, RH = 170, PADL = 56, PADR = 14, PADT = 12, GAPY = 30;
  const totalH = PADT + PH + GAPY + RH + 34;

  let body: React.ReactNode;
  if (err) body = <div style={{ padding: 40, color: RED, fontFamily: "monospace" }}>❌ {err}</div>;
  else if (!data) body = <div style={{ padding: 40, color: TEXT, fontFamily: "monospace" }}>⏳ Chart ban raha hai…</div>;
  else {
    const n = data.closes.length;
    const X = (i: number) => PADL + (i / Math.max(1, n - 1)) * (W - PADL - PADR);
    const pMin = Math.min(...data.lows) * 0.99, pMax = Math.max(...data.highs) * 1.01;
    const PY = (v: number) => PADT + (1 - (v - pMin) / (pMax - pMin)) * PH;
    const rTop = PADT + PH + GAPY;
    const RY = (v: number) => rTop + (1 - v / 100) * RH;

    const pricePath = data.closes.map((c, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${PY(c).toFixed(1)}`).join("");
    const rsiPath = data.rsi.map((c, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${RY(c).toFixed(1)}`).join("");

    const priceTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => pMin + f * (pMax - pMin));
    const dateTicks = [0, 0.25, 0.5, 0.75, 0.999].map((f) => Math.floor(f * (n - 1)));

    body = (
      <svg viewBox={`0 0 ${W} ${totalH}`} style={{ width: "100%", display: "block", background: "#0b0f16", borderRadius: 8 }}>
        {/* grids + axes */}
        {priceTicks.map((v, i) => (
          <g key={"pt" + i}>
            <line x1={PADL} x2={W - PADR} y1={PY(v)} y2={PY(v)} stroke={GRID} strokeWidth={1} />
            <text x={PADL - 6} y={PY(v) + 4} fill={TEXT} fontSize={10} textAnchor="end" fontFamily="monospace">₹{Math.round(v)}</text>
          </g>
        ))}
        {[30, 50, 70].map((v) => (
          <g key={"rt" + v}>
            <line x1={PADL} x2={W - PADR} y1={RY(v)} y2={RY(v)} stroke={v === 50 ? GRID : "#2a3342"} strokeWidth={1} strokeDasharray={v === 50 ? "" : "4 4"} />
            <text x={PADL - 6} y={RY(v) + 4} fill={TEXT} fontSize={10} textAnchor="end" fontFamily="monospace">{v}</text>
          </g>
        ))}
        {dateTicks.map((i) => (
          <text key={"d" + i} x={X(i)} y={totalH - 14} fill={TEXT} fontSize={9.5} textAnchor="middle" fontFamily="monospace">{data.dates[i]}</text>
        ))}
        <text x={PADL} y={PADT + 12} fill="#e6edf5" fontSize={12} fontFamily="monospace" fontWeight={700}>PRICE (close)</text>
        <text x={PADL} y={rTop + 14} fill="#e6edf5" fontSize={12} fontFamily="monospace" fontWeight={700}>RSI (14)</text>

        {/* series */}
        <path d={pricePath} fill="none" stroke="#60a5fa" strokeWidth={1.4} />
        <path d={rsiPath} fill="none" stroke="#c084fc" strokeWidth={1.3} />

        {/* divergence marks: price panel pivots use lows (bullish) / highs (bearish) */}
        {data.events.map((e, i) => {
          const col = e.type === "bullish" ? GREEN : RED;
          const y1p = PY(e.p1.price), y2p = PY(e.p2.price);
          const y1r = RY(e.p1.rsi), y2r = RY(e.p2.rsi);
          const cx = X(Math.min(e.confirmX, n - 1));
          return (
            <g key={i}>
              {/* price trendline */}
              <line x1={X(e.p1.x)} y1={y1p} x2={X(e.p2.x)} y2={y2p} stroke={col} strokeWidth={2} />
              <circle cx={X(e.p1.x)} cy={y1p} r={3.5} fill={col} />
              <circle cx={X(e.p2.x)} cy={y2p} r={3.5} fill={col} />
              {/* rsi trendline — SAME divergence RSI values pe */}
              <line x1={X(e.p1.x)} y1={y1r} x2={X(e.p2.x)} y2={y2r} stroke={col} strokeWidth={2} />
              <circle cx={X(e.p1.x)} cy={y1r} r={3} fill={col} />
              <circle cx={X(e.p2.x)} cy={y2r} r={3} fill={col} />
              {/* pivot-to-pivot vertical guide (halka) */}
              <line x1={X(e.p2.x)} y1={y2p} x2={X(e.p2.x)} y2={y2r} stroke={col} strokeWidth={0.7} strokeDasharray="3 5" opacity={0.5} />
              {/* confirm marker */}
              <text x={cx} y={e.type === "bullish" ? PY(data.lows[Math.min(e.confirmX, n - 1)]) + 16 : PY(data.highs[Math.min(e.confirmX, n - 1)]) - 8} fill={col} fontSize={13} textAnchor="middle" fontWeight={700}>
                {e.type === "bullish" ? "▲" : "▼"}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0f141c", border: "1px solid #2a3342", borderRadius: 12, width: "min(980px, 96vw)", maxHeight: "92vh", overflowY: "auto", padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ color: "#e6edf5", fontWeight: 800, fontSize: 16 }}>📐 {symbol.replace(".NS", "")} — RSI Divergence Chart{asOf ? <span style={{ color: "#c084fc", fontSize: 12, marginLeft: 8 }}>as of {asOf} (playback)</span> : null}</div>
            {name && <div style={{ color: TEXT, fontSize: 12 }}>{name}</div>}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", fontFamily: "monospace", fontSize: 11.5 }}>
            <span style={{ color: GREEN }}>━ Bullish div (▲ confirm)</span>
            <span style={{ color: RED }}>━ Bearish div (▼ confirm)</span>
            <button onClick={onClose} style={{ background: "#151b27", border: "1px solid #2a3342", color: "#e6edf5", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 13 }}>✕ Close</button>
          </div>
        </div>
        {body}
        {data && data.events.length === 0 && (
          <div style={{ color: TEXT, fontFamily: "monospace", fontSize: 12, marginTop: 8 }}>Is window (last ~400 sessions) mein koi divergence event nahi mila.</div>
        )}
        <div style={{ color: "#576575", fontFamily: "monospace", fontSize: 11, marginTop: 8 }}>
          Line dono panels pe SAME do pivots ko jodti hai — price aur RSI ki opposite dhalan (slope) hi divergence hai. ▲/▼ = wo bar jahan pivot confirm hua (yahi signal bar hai, pivot ke {`3`} bars baad — no look-ahead).
        </div>
      </div>
    </div>
  );
}
