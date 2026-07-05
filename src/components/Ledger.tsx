import React, { useState } from "react";

export interface TradeRecord {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  win: boolean;
  depthPct?: number;
  durationM?: number;
  forced?: boolean;
}

export interface LedgerRow {
  symbol: string;
  name: string;
  strategyId: string;
  strategyLabel: string;
  entryCond: string;
  exitCond: string;
  lastEntryPrice: number | null;
  lastExitPrice: number | null;
  lastReturnPct: number | null;
  winRatePct: number;
  profitFactor: number;
  numTrades: number;
  avgReturnPct: number;
  maxDrawdownPct: number;
  liveSignal: boolean;
  livePrice: number | null;
  isSynthetic?: boolean;
  tradesKey?: string;
  trades?: TradeRecord[];                                        // playback snapshots ship trades inline
  openPosition?: { entryDate: string; entryPrice: number } | null; // playback: position open on that date
  patternDepth?: number;
  patternDuration?: number;
}

interface LedgerProps {
  rows: LedgerRow[];
  showStrategy: boolean;
  sortField: keyof LedgerRow | null;
  sortAsc: boolean;
  onSort: (field: keyof LedgerRow) => void;
  historyStart: string; // YYYY-MM-DD — only signals on/after this date are shown
  strictHighlight?: boolean; // M2: badge rows meeting the strict 15-trade / PF 2.5 standard
  onTradeTaken?: () => void; // notify parent so the "My Trades" tab badge updates
  playbackDate?: string | null; // set => TIME MACHINE mode: rows are an as-of-this-date snapshot
}

const fmt = (v: number | null, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));

export function Ledger({ rows, showStrategy, sortField, sortAsc, onSort, historyStart, strictHighlight, onTradeTaken, playbackDate }: LedgerProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradesCache, setTradesCache] = useState<Record<string, TradeRecord[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  // "✋ Take this trade" mini-form state
  const [takeOpen, setTakeOpen] = useState<string | null>(null); // rowKey of open form
  const [tEntry, setTEntry] = useState("");
  const [tStop, setTStop] = useState("");
  const [tTarget, setTTarget] = useState("");
  const [takeMsg, setTakeMsg] = useState("");
  const [taking, setTaking] = useState(false);
  // Playback practice-trade form uses PERCENTAGES (entry fills at next session's open)
  const [tStopPct, setTStopPct] = useState("");
  const [tTargetPct, setTTargetPct] = useState("");

  const colCount = showStrategy ? 13 : 12;

  const renderSortIcon = (field: keyof LedgerRow) => {
    if (sortField !== field) return <span className="sort-icon">↕</span>;
    return sortAsc ? <span className="sort-icon active">▲</span> : <span className="sort-icon active">▼</span>;
  };

  const toggleRow = async (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    if (expanded === rowKey) { setExpanded(null); return; }
    setExpanded(rowKey);
    const key = r.tradesKey || `${r.symbol}__${r.strategyId}`;
    if (r.trades) { // playback snapshot rows carry their as-of trades inline
      setTradesCache((prev) => ({ ...prev, [key]: r.trades! }));
      return;
    }
    if (!tradesCache[key]) {
      setLoadingKey(key);
      try {
        const res = await fetch(`/cache/trades/${encodeURIComponent(key)}.json`);
        const data = res.ok ? await res.json() : [];
        setTradesCache((prev) => ({ ...prev, [key]: Array.isArray(data) ? data : [] }));
      } catch {
        setTradesCache((prev) => ({ ...prev, [key]: [] }));
      } finally {
        setLoadingKey(null);
      }
    }
  };

  const formatDateHuman = (dateStr: string) => {
    if (!dateStr) return "";
    const parts = dateStr.split("-");
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mIdx = parseInt(m, 10) - 1;
    return `${parseInt(d, 10)} ${months[mIdx] || m} ${y}`;
  };

  const openTakeForm = (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    const isM2 = r.strategyId === "m2_rounding_bottom";
    if (playbackDate) {
      setTStopPct(String(isM2 ? 5 : 8));
      setTTargetPct(String(isM2 ? 15 : Math.max(3, Math.round(r.avgReturnPct))));
      setTakeMsg("");
      setTakeOpen(rowKey);
      return;
    }
    // LIVE row → prefill from live price; otherwise user MUST type their actual entry
    const base = r.liveSignal && r.livePrice ? r.livePrice : 0;
    setTEntry(base ? String(base) : "");
    setTStop(base ? String(Math.round(base * (isM2 ? 0.95 : 0.92))) : "");
    setTTarget(base ? String(isM2 ? Math.round(base * 1.15) : Math.round(base * (1 + Math.max(r.avgReturnPct, 3) / 100))) : "");
    setTakeMsg("");
    setTakeOpen(rowKey);
  };

  const recalcFromEntry = (r: LedgerRow, entryStr: string) => {
    setTEntry(entryStr);
    const e = Number(entryStr);
    if (isFinite(e) && e > 0) {
      const isM2 = r.strategyId === "m2_rounding_bottom";
      setTStop(String(Math.round(e * (isM2 ? 0.95 : 0.92))));
      setTTarget(String(isM2 ? Math.round(e * 1.15) : Math.round(e * (1 + Math.max(r.avgReturnPct, 3) / 100))));
    }
  };

  const submitPlaybackTake = async (r: LedgerRow) => {
    const stopPct = Number(tStopPct), targetPct = Number(tTargetPct);
    if (!isFinite(stopPct) || stopPct <= 0 || stopPct >= 50) { setTakeMsg("❌ Stop% 0-50 ke beech do"); return; }
    if (!isFinite(targetPct) || targetPct <= 0) { setTakeMsg("❌ Target% valid do"); return; }
    setTaking(true);
    try {
      const res = await fetch("/api/playback/trades/take", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: r.symbol, name: r.name, strategyId: r.strategyId, strategyLabel: r.strategyLabel,
          module: r.strategyId?.startsWith("m2") ? "m2" : r.strategyId?.startsWith("m3") ? "m3" : "m1",
          signalDate: playbackDate, stopPct, targetPct,
          depthPct: r.patternDepth, durationM: r.patternDuration
        })
      });
      const d = await res.json();
      if (d.ok) {
        setTakeMsg("✅ Practice journal mein add — entry AGLE session ke open pe hogi, din aage badhao");
        setTakeOpen(null);
        if (onTradeTaken) onTradeTaken();
      } else setTakeMsg(`❌ ${d.error || "save fail"}`);
    } catch {
      setTakeMsg("❌ Server se connect nahi hua");
    } finally {
      setTaking(false);
    }
  };

  const submitTake = async (r: LedgerRow) => {
    const entryPrice = Number(tEntry), stopPrice = Number(tStop), targetPrice = Number(tTarget);
    if (!isFinite(entryPrice) || entryPrice <= 0) { setTakeMsg("❌ Valid entry price daalo"); return; }
    if (!isFinite(stopPrice) || stopPrice >= entryPrice) { setTakeMsg("❌ Stop-loss entry se NEECHE hona chahiye"); return; }
    if (!isFinite(targetPrice) || targetPrice <= entryPrice) { setTakeMsg("❌ Target entry se UPAR hona chahiye"); return; }
    setTaking(true);
    try {
      const res = await fetch("/api/trades/take", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: r.symbol, name: r.name, strategyId: r.strategyId, strategyLabel: r.strategyLabel,
          module: r.strategyId?.startsWith("m2") ? "m2" : r.strategyId?.startsWith("m3") ? "m3" : "m1",
          entryPrice, stopPrice, targetPrice
        })
      });
      const d = await res.json();
      if (d.ok) {
        setTakeMsg("✅ Journal mein add ho gaya — 'My Trades' tab mein track hoga");
        setTakeOpen(null);
        if (onTradeTaken) onTradeTaken();
      } else setTakeMsg(`❌ ${d.error || "save fail"}`);
    } catch {
      setTakeMsg("❌ Server se connect nahi hua");
    } finally {
      setTaking(false);
    }
  };

  const inp: React.CSSProperties = { background: "#0f141c", border: "1px solid #2a3342", color: "#e6edf5", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace", width: "92px", fontSize: "12px" };

  const renderTakeSection = (r: LedgerRow) => {
    const rowKey = r.symbol + r.strategyId;
    const formOpen = takeOpen === rowKey;
    if (playbackDate) {
      // Practice mode: act ONLY on that day's fresh signal (that's the whole exercise)
      if (!r.liveSignal) return null;
      return (
        <div style={{ marginBottom: "12px" }}>
          {!formOpen ? (
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <button
                onClick={() => openTakeForm(r)}
                style={{ background: "linear-gradient(90deg,#a855f7,#7c3aed)", color: "#fff", fontWeight: 800, border: "none", borderRadius: "7px", padding: "7px 14px", fontSize: "12.5px", cursor: "pointer" }}
              >
                ✋ Take this trade (practice)
              </button>
              {takeMsg && <span style={{ fontSize: "12px", fontFamily: "monospace", color: takeMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{takeMsg}</span>}
            </div>
          ) : (
            <div style={{ padding: "10px 12px", borderRadius: "8px", background: "rgba(168,85,247,0.07)", border: "1px solid rgba(168,85,247,0.4)", fontFamily: "monospace", fontSize: "12px", color: "#c9d3df" }}>
              <div style={{ fontWeight: 700, color: "#c084fc", marginBottom: "8px" }}>🕰 Practice trade — {r.symbol.replace(".NS", "")} @ signal {playbackDate}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
                <label>Stop-loss % <input style={{ ...inp, borderColor: "rgba(239,68,68,0.5)", width: "64px" }} value={tStopPct} onChange={(e) => setTStopPct(e.target.value)} /></label>
                <label>Target % <input style={{ ...inp, borderColor: "rgba(34,197,94,0.5)", width: "64px" }} value={tTargetPct} onChange={(e) => setTTargetPct(e.target.value)} /></label>
                <button onClick={() => submitPlaybackTake(r)} disabled={taking} style={{ background: "#a855f7", color: "#fff", fontWeight: 800, border: "none", borderRadius: "6px", padding: "6px 14px", cursor: "pointer", fontSize: "12px", opacity: taking ? 0.6 : 1 }}>
                  {taking ? "Saving…" : "✓ Lock decision"}
                </button>
                <button onClick={() => setTakeOpen(null)} style={{ background: "transparent", color: "#8e9ba9", border: "1px solid #2a3342", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "12px" }}>Cancel</button>
              </div>
              <div style={{ color: "#8e9ba9", fontSize: "11px", marginTop: "7px" }}>
                Entry <strong>agle trading session ke open</strong> pe fill hogi (jaise engine karta hai) — % levels abhi lock ho rahe hain, bilkul real jaise.
              </div>
              {takeMsg && <div style={{ marginTop: "6px", color: takeMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{takeMsg}</div>}
            </div>
          )}
        </div>
      );
    }
    return (
      <div style={{ marginBottom: "12px" }}>
        {!formOpen ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <button
              onClick={() => openTakeForm(r)}
              style={{ background: "linear-gradient(90deg,#fbbf24,#d97706)", color: "#080b11", fontWeight: 800, border: "none", borderRadius: "7px", padding: "7px 14px", fontSize: "12.5px", cursor: "pointer" }}
            >
              ✋ Take this trade
            </button>
            {takeMsg && <span style={{ fontSize: "12px", fontFamily: "monospace", color: takeMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{takeMsg}</span>}
          </div>
        ) : (
          <div style={{ padding: "10px 12px", borderRadius: "8px", background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.35)", fontFamily: "monospace", fontSize: "12px", color: "#c9d3df" }}>
            <div style={{ fontWeight: 700, color: "#fbbf24", marginBottom: "8px" }}>✋ Taking {r.symbol.replace(".NS", "")} — apna actual plan confirm karo</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
              <label>Entry ₹ <input style={inp} value={tEntry} onChange={(e) => recalcFromEntry(r, e.target.value)} placeholder="e.g. 3048" /></label>
              <label>Stop ₹ <input style={{ ...inp, borderColor: "rgba(239,68,68,0.5)" }} value={tStop} onChange={(e) => setTStop(e.target.value)} /></label>
              <label>Target ₹ <input style={{ ...inp, borderColor: "rgba(34,197,94,0.5)" }} value={tTarget} onChange={(e) => setTTarget(e.target.value)} /></label>
              <button onClick={() => submitTake(r)} disabled={taking} style={{ background: "#22c55e", color: "#04110a", fontWeight: 800, border: "none", borderRadius: "6px", padding: "6px 14px", cursor: "pointer", fontSize: "12px", opacity: taking ? 0.6 : 1 }}>
                {taking ? "Saving…" : "✓ Confirm"}
              </button>
              <button onClick={() => setTakeOpen(null)} style={{ background: "transparent", color: "#8e9ba9", border: "1px solid #2a3342", borderRadius: "6px", padding: "6px 12px", cursor: "pointer", fontSize: "12px" }}>Cancel</button>
            </div>
            {!r.liveSignal && (
              <div style={{ color: "#f59e0b", fontSize: "11px", marginTop: "7px" }}>⚠️ Is stock pe abhi LIVE signal nahi hai — apne broker ka ACTUAL entry price daalo, purane backtest price pe mat jao.</div>
            )}
            {takeMsg && <div style={{ marginTop: "6px", color: takeMsg.startsWith("✅") ? "#22c55e" : "#ef4444" }}>{takeMsg}</div>}
          </div>
        )}
      </div>
    );
  };

  const renderTodayPlan = (r: LedgerRow) => {
    if (playbackDate && r.openPosition && !r.liveSignal) {
      return (
        <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "8px", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.35)", fontFamily: "monospace", fontSize: "12.5px", color: "#f5e3b8" }}>
          <div style={{ fontWeight: 700, color: "#fbbf24", marginBottom: "4px" }}>🟡 Position OPEN on this date</div>
          <div>Strategy is date pe position mein tha — entry <strong>{r.openPosition.entryDate}</strong> @ <strong>₹{Math.round(r.openPosition.entryPrice)}</strong>. Exit abhi future mein hai (spoiler nahi denge 😄) — din aage badha ke dekho.</div>
        </div>
      );
    }
    if (r.liveSignal && r.livePrice) {
      const entry = r.livePrice;
      // M2's tested rule is a −5% stop / +15% target; showing −8% here contradicted the
      // strategy that produced the stats. Other strategies keep the generic −8% guard.
      const isM2 = r.strategyId === "m2_rounding_bottom";
      const stopPct = isM2 ? 5 : 8;
      const stop = Math.round(entry * (1 - stopPct / 100));
      const target = isM2 ? Math.round(entry * 1.15) : Math.round(entry * (1 + r.avgReturnPct / 100));
      const targetLabel = isM2 ? "+15% rule" : `+${r.avgReturnPct.toFixed(1)}% avg`;
      const risk = entry - stop;
      const reward = target - entry;
      const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
      return (
        <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "8px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", fontFamily: "monospace", fontSize: "12.5px", color: "#c9f5d6" }}>
          <div style={{ fontWeight: 700, color: "#22c55e", marginBottom: "4px" }}>📍 {playbackDate ? `Signal on ${playbackDate} (as-of close that day)` : "LIVE setup (as of latest close)"}</div>
          <div>Entry zone ≈ <strong>₹{entry}</strong> · Stop-loss <strong>₹{stop}</strong> (−{stopPct}%) · Target ≈ <strong>₹{target}</strong> ({targetLabel}) · R:R ≈ 1:{rr}</div>
          <div style={{ color: "#8e9ba9", fontSize: "11px", marginTop: "5px" }}>Enter only if price is still near the entry zone (not already run up). Backtest-derived levels — educational, not financial advice.</div>
        </div>
      );
    }
    return (
      <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "8px", background: "rgba(142,155,169,0.08)", border: "1px solid #2a3342", fontFamily: "monospace", fontSize: "12.5px", color: "#a7b2c0" }}>
        <div style={{ fontWeight: 700, color: "#8e9ba9", marginBottom: "4px" }}>⚪ No live entry today — history only</div>
        <div>
          The trades below are <strong>past backtest signals</strong>{r.lastEntryPrice ? ` (last one entered at ₹${Math.round(r.lastEntryPrice)}, long gone)` : ""}. Don't buy at those old prices. Wait for a <strong>LIVE</strong> signal — use the “LIVE Signals Only” filter to see stocks that are entry-ready now.
        </div>
      </div>
    );
  };

  const renderOOS = (all: TradeRecord[]) => {
    if (!all || all.length < 12) return null; // need enough trades to split
    const clean = all.filter((t) => Math.abs(t.returnPct) <= 200); // drop data-glitch outliers
    const sorted = [...clean].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const k = Math.floor(sorted.length * 0.7);
    const train = sorted.slice(0, k);
    const test = sorted.slice(k);
    if (test.length < 4) return null;
    const winPct = (t: TradeRecord[]) => (t.length ? Math.round((100 * t.filter((x) => x.win).length) / t.length) : 0);
    const pf = (t: TradeRecord[]) => {
      const gp = t.filter((x) => x.returnPct > 0).reduce((sum, x) => sum + x.returnPct, 0);
      const gl = Math.abs(t.filter((x) => x.returnPct < 0).reduce((sum, x) => sum + x.returnPct, 0));
      return gl > 0 ? Math.min(gp / gl, 10) : 10;
    };
    const trW = winPct(train), teW = winPct(test), trP = pf(train), teP = pf(test);
    const holds = teW >= trW - 8 && teP >= 1.5;
    const col = holds ? "#22c55e" : "#f59e0b";
    const bg = holds ? "rgba(34,197,94,0.08)" : "rgba(245,158,11,0.08)";
    const bd = holds ? "rgba(34,197,94,0.35)" : "rgba(245,158,11,0.35)";
    return (
      <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "8px", background: bg, border: `1px solid ${bd}`, fontFamily: "monospace", fontSize: "12.5px", color: "#c9d3df", textAlign: "left" }}>
        <div style={{ fontWeight: 700, color: col, marginBottom: "4px" }}>
          🔬 Out-of-sample check — {holds ? "edge HOLDS in recent data ✓" : "edge DECAYED in recent data ⚠"}
        </div>
        <div>
          Train (first 70%, {train.length} tr): win <strong>{trW}%</strong> · PF <strong>{trP.toFixed(1)}</strong>
          {" → "}Test (last 30%, {test.length} tr): win <strong>{teW}%</strong> · PF <strong>{teP.toFixed(1)}</strong>
        </div>
        <div style={{ color: "#8e9ba9", fontSize: "11px", marginTop: "5px" }}>
          Strategy is chosen on full history, so “Test” is the closest thing to forward performance. A big drop = the headline number is optimistic.
        </div>
      </div>
    );
  };

  const renderHistory = (r: LedgerRow) => {
    const key = r.tradesKey || `${r.symbol}__${r.strategyId}`;
    const all = tradesCache[key];
    if (loadingKey === key || all === undefined) {
      return <div style={{ padding: "14px", color: "#8e9ba9", fontFamily: "monospace", fontSize: "12px" }}>Loading trade history…</div>;
    }
    const filtered = all
      .filter((t) => t.entryDate >= historyStart)
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate));
    if (!filtered.length) {
      return (
        <div style={{ padding: "12px 14px" }}>
          {renderTodayPlan(r)}
          {renderTakeSection(r)}
          {renderOOS(all)}
          <div style={{ color: "#8e9ba9", fontFamily: "monospace", fontSize: "12px" }}>
            No signals found since <strong>{formatDateHuman(historyStart)}</strong> (out of {all.length} total backtest signals).
          </div>
        </div>
      );
    }
    const wins = filtered.filter((t) => t.win).length;
    const losses = filtered.length - wins;
    const wr = Math.round((wins / filtered.length) * 100);
    return (
      <div style={{ padding: "12px 14px" }}>
        {renderTodayPlan(r)}
        {renderTakeSection(r)}
        {renderOOS(all)}
        <div style={{ marginBottom: "12px", fontSize: "13px", color: "#c9d3df", fontFamily: "monospace", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
          <span style={{ backgroundColor: "rgba(59, 130, 246, 0.15)", color: "#60a5fa", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "2px 6px", borderRadius: "4px", fontSize: "11px", fontWeight: "bold" }}>
            DATE FILTER ACTIVE
          </span>
          <span>
            Showing <strong>{filtered.length}</strong> of <strong>{all.length}</strong> total backtest signals since <strong>{formatDateHuman(historyStart)}</strong> —{" "}
            <span className="text-success">{wins} profit</span> ·{" "}
            <span className="text-danger">{losses} loss</span> · <strong>{wr}% win rate</strong>
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ color: "#8e9ba9", textAlign: "left" }}>
                <th style={{ padding: "6px 10px" }}>Entry Date</th>
                <th style={{ padding: "6px 10px" }}>Exit Date</th>
                <th style={{ padding: "6px 10px" }}>Entry ₹</th>
                <th style={{ padding: "6px 10px" }}>Exit ₹</th>
                <th style={{ padding: "6px 10px" }}>Return</th>
                <th style={{ padding: "6px 10px" }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, j) => (
                <tr key={j} style={{ borderTop: "1px solid #1b2230" }}>
                  <td className="mono" style={{ padding: "6px 10px" }}>{t.entryDate}</td>
                  <td className="mono" style={{ padding: "6px 10px" }}>{t.exitDate}</td>
                  <td className="mono" style={{ padding: "6px 10px" }}>{t.entryPrice}</td>
                  <td className="mono" style={{ padding: "6px 10px" }}>{t.exitPrice}</td>
                  <td className={`mono ${t.win ? "text-success" : "text-danger"}`} style={{ padding: "6px 10px" }}>
                    {(t.returnPct >= 0 ? "+" : "") + t.returnPct}%
                  </td>
                  <td style={{ padding: "6px 10px" }}>
                    <span className={`badge ${t.win ? "badge-success" : "badge-danger"}`}>{t.win ? "PROFIT" : "LOSS"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="ledger-wrap">
      <table className="ledger">
        <thead>
          <tr>
            <th className="l sortable" onClick={() => onSort("symbol")}>
              Stock {renderSortIcon("symbol")}
            </th>
            {showStrategy && (
              <th className="l sortable" onClick={() => onSort("strategyLabel")}>
                Strategy {renderSortIcon("strategyLabel")}
              </th>
            )}
            <th className="l">Entry Condition</th>
            <th className="sortable" onClick={() => onSort("lastEntryPrice")}>
              Entry ₹ {renderSortIcon("lastEntryPrice")}
            </th>
            <th className="l">Exit Condition</th>
            <th className="sortable" onClick={() => onSort("lastExitPrice")}>
              Exit ₹ {renderSortIcon("lastExitPrice")}
            </th>
            <th className="sortable" onClick={() => onSort("lastReturnPct")}>
              Return {renderSortIcon("lastReturnPct")}
            </th>
            <th className="sortable" onClick={() => onSort("winRatePct")}>
              Win% {renderSortIcon("winRatePct")}
            </th>
            <th className="sortable" onClick={() => onSort("profitFactor")}>
              PF {renderSortIcon("profitFactor")}
            </th>
            <th className="sortable" onClick={() => onSort("numTrades")}>
              Trades {renderSortIcon("numTrades")}
            </th>
            <th className="sortable" onClick={() => onSort("avgReturnPct")}>
              Avg {renderSortIcon("avgReturnPct")}
            </th>
            <th className="sortable" onClick={() => onSort("maxDrawdownPct")}>
              MaxDD {renderSortIcon("maxDrawdownPct")}
            </th>
            <th className="sortable" onClick={() => onSort("liveSignal")}>
              Signal {renderSortIcon("liveSignal")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cleanSym = r.symbol.replace(".NS", "");
            const returnPct = r.lastReturnPct;
            const status = returnPct !== null && returnPct !== undefined ? (returnPct > 0 ? "win" : "loss") : null;
            const stats = r;
            const live = r.liveSignal;
            const dp = r.patternDepth;
            const dm = r.patternDuration;

            let returnClass = "badge-neutral";
            if (returnPct !== null && returnPct !== undefined) {
              returnClass = returnPct >= 0 ? "badge-success" : "badge-danger";
            }

            const avgReturnClass = r.avgReturnPct >= 0 ? "text-success" : "text-danger";
            const isStrict = r.numTrades >= 15 && r.profitFactor >= 2.5 && r.winRatePct >= 60;
            const rowKey = r.symbol + r.strategyId;
            const isOpen = expanded === rowKey;

            return (
              <React.Fragment key={rowKey + i}>
                <tr className={r.liveSignal ? "row-live" : ""}>
                  <td className="l sym" style={{ cursor: "pointer" }} onClick={() => toggleRow(r)} title="Click to view full signal history">
                    <div className="sym-box">
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ color: "#fbbf24", fontFamily: "monospace", width: "10px", display: "inline-block" }}>{isOpen ? "▾" : "▸"}</span>
                        <span className="sym-ticker">{cleanSym}</span>
                        {r.isSynthetic && (
                          <span style={{ fontSize: "10px", backgroundColor: "rgba(245, 158, 11, 0.15)", color: "#f59e0b", border: "1px solid rgba(245, 158, 11, 0.3)", padding: "0px 4px", borderRadius: "3px", fontWeight: "normal", fontFamily: "monospace" }}>
                            SYNTHETIC
                          </span>
                        )}
                        {strictHighlight && isStrict && (
                          <span style={{ fontSize: "10px", backgroundColor: "rgba(34, 197, 94, 0.15)", color: "#22c55e", border: "1px solid rgba(34, 197, 94, 0.4)", padding: "0px 5px", borderRadius: "3px", fontWeight: 700, fontFamily: "monospace" }}>
                            STRICT ✓
                          </span>
                        )}
                      </div>
                      <span className="sym-name">{r.name}</span>
                    </div>
                  </td>
                  {showStrategy && <td className="l strategy-cell">{r.strategyLabel}</td>}
                  <td className="cond entry-cond">{r.entryCond}</td>
                  <td className="mono font-semibold">{fmt(r.lastEntryPrice)}</td>
                  <td className="cond exit-cond">{r.exitCond}</td>
                  <td className="mono font-semibold">{fmt(r.lastExitPrice)}</td>
                  <td>
                    <span className={`badge ${returnClass}`}>
                      {returnPct === null || returnPct === undefined ? "—" : (returnPct >= 0 ? "+" : "") + fmt(returnPct) + "%"}
                    </span>
                  </td>
                  <td className="mono">{fmt(r.winRatePct, 1)}%</td>
                  <td>
                    <span className={`pf-value ${r.profitFactor >= 2 ? "pf-premium" : "pf-standard"}`}>
                      {fmt(r.profitFactor, 2)}
                    </span>
                  </td>
                  <td className="mono">{r.numTrades}</td>
                  <td className={`mono ${avgReturnClass}`}>
                    {(r.avgReturnPct >= 0 ? "+" : "") + fmt(r.avgReturnPct) + "%"}
                  </td>
                  <td className="mono text-danger-dim">{fmt(r.maxDrawdownPct, 1)}%</td>
                  <td>
                    {r.liveSignal ? (
                      <span className="live-pill"><span className="pulse-dot" />LIVE</span>
                    ) : (
                      <span className="live-pill off"><span className="pulse-dot" />OFF</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="trade-history-row">
                    <td colSpan={colCount} style={{ background: "#0b0f16", borderTop: "1px solid #1b2230" }}>
                      {renderHistory(r)}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
