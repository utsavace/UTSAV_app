import React, { useEffect, useState, useMemo, useRef } from "react";
import { Ledger, type LedgerRow } from "./components/Ledger.tsx";

interface Meta {
  needsScan?: boolean;
  stale?: boolean;        // ← add
  reason?: string;        // ← add
  generatedAt?: string;
  universeCount?: number;
  scanned?: number;
  withData?: number;
  elapsedSec?: number;
  gate?: {
    minWinRate: number;
    minProfitFactor: number;
    minOosTrades: number;
    strict?: { minProfitFactor: number; minOosTrades: number };
  };
  walkForward?: { trainFrac: number; note: string };
  backtestMethod?: { type: string; note: string };
  module3?: {
    chosenStrategyLabel: string;
    gatePasses: number;
    breadth: { label: string; gatePasses: number; medianPF: number }[];
  };
  roundingBottomConditions?: { totalTrades: number; byDepth: Bucketed; byDuration: Bucketed };
  counts?: { module1: number; module2: number; module3: number };
  passed?: number;
}

interface Bucketed {
  label: string;
  buckets: { range: string; trades: number; winRatePct: number }[];
}

const TABS = [
  { n: 1, key: "opt", label: "AI Strategy Optimizer" },
  { n: 2, key: "rb", label: "Rounding Bottom" },
  { n: 3, key: "best", label: "Best Overall Edge" },
] as const;

const DESC: Record<number, string> = {
  1: "Analyzes each stock to evaluate and select its highest-performing backtest strategy (RSI, MACD, EMA, Bollinger, and ADX combinations) using a full-history daily single-pass evaluation.",
  2: "Detects rounding bottom (U-shaped) consolidation bases (12-33% cup depth) on full-history charts. Confirms pattern parameters, monitors breakout structures, and tracks precise entry and exit statistics.",
  3: "Identifies the single high-probability technical strategy that registers the greatest number of breadth passes across the entire Nifty 500 universe to maximize robustness.",
};

export default function App() {
  const [tab, setTab] = useState(1);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [m2Strict, setM2Strict] = useState(true); // M2: highlight rows meeting strict 15/2.5 (default ON)
  const [historyStart, setHistoryStart] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5); // default: last 5 years; pick any older date to go further back
    return d.toISOString().slice(0, 10);
  });
  const [sortField, setSortField] = useState<keyof LedgerRow | null>(null);
  const [sortAsc, setSortAsc] = useState(false);

  // --- Period P&L Summary ---
  const [showPnl, setShowPnl] = useState(false);
  const [allTradesData, setAllTradesData] = useState<any[] | null>(null);
  const [pnlFrom, setPnlFrom] = useState(() => `${new Date().getFullYear()}-01-01`);
  const [pnlTo, setPnlTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [pnlScope, setPnlScope] = useState<"tab" | "all">("all");
  useEffect(() => {
    if (showPnl && allTradesData === null) {
      fetch(`/cache/alltrades.json?t=${Date.now()}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setAllTradesData)
        .catch(() => setAllTradesData([]));
    }
  }, [showPnl, allTradesData]);
  const pnl = useMemo(() => {
    if (!allTradesData) return null;
    const mod = `m${tab}`;
    const scoped = allTradesData.filter(
      (t) => (pnlScope === "all" || t.mod === mod) && t.e >= pnlFrom && t.e <= pnlTo
    );
    const n = scoped.length;
    const wins = scoped.filter((t) => t.w).length;
    const sum = scoped.reduce((a, t) => a + t.r, 0);
    return {
      n, wins, losses: n - wins,
      wr: n ? Math.round((100 * wins) / n) : 0,
      sum, avg: n ? sum / n : 0,
      best: n ? Math.max(...scoped.map((t) => t.r)) : 0,
      worst: n ? Math.min(...scoped.map((t) => t.r)) : 0,
    };
  }, [allTradesData, tab, pnlScope, pnlFrom, pnlTo]);

  // Scanning engine states
  const [scanStatus, setScanStatus] = useState<{
    isScanning: boolean;
    progress: number;
    scanned: number;
    currentSymbol: string;
    passedCount: number;
    logs: string[];
  }>({
    isScanning: false,
    progress: 0,
    scanned: 0,
    currentSymbol: "",
    passedCount: 0,
    logs: []
  });

  const startScanning = async () => {
    try {
      const res = await fetch("/api/scan/start", { method: "POST" });
      const data = await res.json();
      if (data.status === "started" || data.status === "already_running") {
        setScanStatus(prev => ({ ...prev, isScanning: true }));
      }
    } catch (e) {
      console.error("Failed to start scan", e);
    }
  };

  // --- One-click "Scan & Publish" (LOCAL DEV ONLY) ---
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState("");
  const publishAfterScan = useRef(false); // ref avoids stale closure inside the polling effect

  const publishCache = async () => {
    setPublishing(true);
    setPublishMsg("Publishing to git…");
    try {
      const r = await fetch("/api/publish", { method: "POST" });
      const d = await r.json();
      setPublishMsg(d.ok ? "✅ Published — now redeploy on AI Studio" : "❌ " + (d.output || "publish failed"));
    } catch (e) {
      setPublishMsg("❌ publish request failed");
    } finally {
      setPublishing(false);
    }
  };

  const scanAndPublish = () => {
    setPublishMsg("");
    publishAfterScan.current = true;
    startScanning(); // scan first; the polling effect calls publishCache() when it finishes
  };

  // Prefer the server's VALIDATED endpoints (/api/*) — they run staleness checks against
  // the recorded gates. Fall back to the static /cache files only if the API is
  // unreachable (pure static hosting). Previously the API existed but was never called,
  // so the whole validation layer was dead code.
  const fetchMeta = (): Promise<Meta> =>
    fetch(`/api/meta?t=${Date.now()}`)
      .then((r) => { if (!r.ok) throw new Error("api down"); return r.json(); })
      .catch(() =>
        fetch(`/cache/meta.json?t=${Date.now()}`)
          .then((r) => { if (!r.ok) throw new Error("no cache"); return r.json(); })
      );

  const fetchModule = (n: number): Promise<LedgerRow[]> =>
    fetch(`/api/module/${n}?t=${Date.now()}`)
      .then((r) => { if (!r.ok) throw new Error("api down"); return r.json(); })
      .then((d) => (Array.isArray(d) ? d : Array.isArray(d.rows) ? d.rows : []))
      .catch(() =>
        fetch(`/cache/module${n}.json?t=${Date.now()}`)
          .then((r) => { if (!r.ok) throw new Error("no cache"); return r.json(); })
          .then((d) => (Array.isArray(d) ? d : []))
      );

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => setMeta({ needsScan: true }));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchModule(tab)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [tab]);

  // Polling loop for active scans
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (scanStatus.isScanning) {
      interval = setInterval(() => {
        fetch("/api/scan/status")
          .then(res => res.json())
          .then(data => {
            setScanStatus({
              isScanning: data.isScanning,
              progress: data.progress,
              scanned: data.scanned,
              currentSymbol: data.currentSymbol,
              passedCount: data.passedCount,
              logs: data.logs || []
            });
            if (!data.isScanning && data.progress === 100) {
              // Reload the freshly-written cache through the validated endpoints
              fetchMeta().then(setMeta).catch(() => {});
              fetchModule(tab).then(setRows).catch(() => {});
              setAllTradesData(null); // force P&L panel to re-fetch fresh alltrades.json
              
              if (publishAfterScan.current) {
                publishAfterScan.current = false;
                publishCache(); // auto-commit + push the fresh cache
              }
            }
          })
          .catch(err => {
            console.error("Error polling scan status", err);
          });
      }, 500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [scanStatus.isScanning, tab]);

  // Reset filter/sort state when changing tabs
  useEffect(() => {
    setSearchQuery("");
    setLiveOnly(false);
    setSortField(null);
    setSortAsc(false);
  }, [tab]);

  const handleSort = (field: keyof LedgerRow) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const filteredAndSortedRows = useMemo(() => {
    let result = [...rows];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          r.symbol.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.strategyLabel.toLowerCase().includes(q)
      );
    }
    if (liveOnly) {
      result = result.filter((r) => r.liveSignal);
    }
    if (sortField) {
      result.sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];
        if (valA === null || valA === undefined) return sortAsc ? -1 : 1;
        if (valB === null || valB === undefined) return sortAsc ? 1 : -1;
        if (typeof valA === "number" && typeof valB === "number") {
          return sortAsc ? valA - valB : valB - valA;
        }
        if (typeof valA === "boolean" && typeof valB === "boolean") {
          return sortAsc ? (valA ? 1 : -1) - (valB ? 1 : -1) : (valB ? 1 : -1) - (valA ? 1 : -1);
        }
        const strA = String(valA).toLowerCase();
        const strB = String(valB).toLowerCase();
        if (strA < strB) return sortAsc ? -1 : 1;
        if (strA > strB) return sortAsc ? 1 : -1;
        return 0;
      });
    }
    return result;
  }, [rows, searchQuery, liveOnly, sortField, sortAsc]);

  const g = meta?.gate;
  const needsScan = meta?.needsScan;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="mark">
            edge<span className="dot">.</span>ledger
          </span>
          <span className="sub">Nifty 500 · Full-History Backtest · Gross Returns</span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {import.meta.env.DEV && (
            <button 
              type="button"
              className="flex items-center gap-2 bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-4.5 py-2.5 rounded-lg text-sm transition-all hover:scale-[1.03] cursor-pointer hover:shadow-[0_4px_15px_rgba(251,191,36,0.35)] active:scale-[0.97]"
              onClick={startScanning}
              disabled={scanStatus.isScanning}
            >
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-black"></span>
              </span>
              Fetch Fresh Data
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              type="button"
              className="flex items-center gap-2 bg-[#151b27] border border-[#fbbf24]/40 text-[#fbbf24] font-bold px-4 py-2.5 rounded-lg text-sm transition-all hover:bg-[#1b2230] cursor-pointer active:scale-[0.97] disabled:opacity-50"
              onClick={scanAndPublish}
              disabled={scanStatus.isScanning || publishing}
            >
              {scanStatus.isScanning ? "Scanning…" : publishing ? "Publishing…" : "🔄 Scan & Publish"}
            </button>
          )}
          {import.meta.env.DEV && publishMsg && (
            <span className="text-xs text-[#8e9ba9] font-mono max-w-[260px] truncate" title={publishMsg}>{publishMsg}</span>
          )}
          <div className="gatestamp">
            <span className="gate-label">STRICT GATE</span>
            <span className="gate-rules">
              Win &gt; {g ? g.minWinRate * 100 : 60}% &amp; PF &gt; {g?.strict?.minProfitFactor ?? g?.minProfitFactor ?? 2.5}
            </span>
          </div>
        </div>
      </header>

      {meta && !needsScan && (
        <section className="stats-dashboard">
          <div className="stat-card">
            <span className="stat-label">Universe Size</span>
            <span className="stat-value">{meta.universeCount} Symbols</span>
            <div className="stat-progress">
              <span className="stat-progress-fill" style={{ width: "100%" }} />
            </div>
            <span className="stat-sub">Nifty 500 universe loaded</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Scanned Data</span>
            <span className="stat-value">
              {meta.withData} <span className="stat-value-sub">/ {meta.scanned}</span>
            </span>
            <div className="stat-progress">
              <span
                className="stat-progress-fill success"
                style={{ width: `${((meta.withData || 0) / (meta.scanned || 1)) * 100}%` }}
              />
            </div>
            <span className="stat-sub">Stocks with historical records</span>
          </div>
          <div className="stat-card highlights">
            <span className="stat-label">Passed Gates</span>
            <span className="stat-value text-gold">
              {meta.passed ?? ((meta.counts?.module1 || 0) + (meta.counts?.module2 || 0) + (meta.counts?.module3 || 0))} <span className="stat-value-sub">Total</span>
            </span>
            <div className="stat-split-bar">
              <span
                className="stat-split-1"
                style={{
                  width: `${
                    ((meta.counts?.module1 || 0) /
                      (((meta.counts?.module1 || 0) + (meta.counts?.module2 || 0) + (meta.counts?.module3 || 0)) || 1)) *
                    100
                  }%`,
                }}
              />
              <span
                className="stat-split-2"
                style={{
                  width: `${
                    (((meta.counts?.module2 || 0) + (meta.counts?.module3 || 0)) /
                      (((meta.counts?.module1 || 0) + (meta.counts?.module2 || 0) + (meta.counts?.module3 || 0)) || 1)) *
                    100
                  }%`,
                }}
              />
            </div>
            <span className="stat-sub">
              M1: {meta.counts?.module1} · M2: {meta.counts?.module2} · M3: {meta.counts?.module3}
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Best Universe Edge</span>
            <span className="stat-value text-premium-blue truncate" title={meta.module3?.chosenStrategyLabel}>
              {meta.module3?.chosenStrategyLabel || "—"}
            </span>
            <div className="stat-progress">
              <span
                className="stat-progress-fill info"
                style={{
                  width: `${((meta.module3?.gatePasses || 0) / (meta.withData || 1)) * 100}%`,
                }}
              />
            </div>
            <span className="stat-sub">{meta.module3?.gatePasses} breadth passes</span>
          </div>
        </section>
      )}

      {meta && meta.generatedAt && (
        <div className="last-updated-bar">
          <span className="pulse-indicator" />
          Data generated at: {new Date(meta.generatedAt).toLocaleString()} ({meta.elapsedSec}s compute time)
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={"tab" + (tab === t.n ? " active" : "")}
            onClick={() => setTab(t.n)}
          >
            <span className="num">{String(t.n).padStart(2, "0")}</span>
            <span className="tab-text">{t.label}</span>
            {meta?.counts && (
              <span className="count">{(meta.counts as any)["module" + t.n] ?? 0}</span>
            )}
          </button>
        ))}
      </nav>

      <section className="panel">
        <div className="panel-head-group">
          <div className="panel-info">
            <h2>{TABS[tab - 1].label}</h2>
            <p>{DESC[tab]}</p>
          </div>
          {!needsScan && rows.length > 0 && (
            <div className="controls-row">
              <div className="search-box">
                <span className="search-icon">🔍</span>
                <input
                  type="text"
                  placeholder="Search stock symbol, name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="clear-btn" onClick={() => setSearchQuery("")}>
                    ✕
                  </button>
                )}
              </div>
              <button
                className={`toggle-filter-btn ${liveOnly ? "active" : ""}`}
                onClick={() => setLiveOnly(!liveOnly)}
              >
                <span className="toggle-dot" />
                LIVE Signals Only
              </button>
              {tab === 2 && (
                <button
                  className={`toggle-filter-btn ${m2Strict ? "active" : ""}`}
                  onClick={() => setM2Strict(!m2Strict)}
                  title="Highlight rounding-bottom rows that also meet the strict standard: 15+ trades & PF >= 2.5"
                >
                  <span className="toggle-dot" />
                  Strict (15 / PF 2.5)
                </button>
              )}
              <div className="history-date-box" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#8e9ba9" }}>
                <span>Signals since</span>
                <input
                  type="date"
                  value={historyStart}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setHistoryStart(e.target.value)}
                  style={{ background: "#0f141c", border: "1px solid #212836", color: "#e6edf5", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }}
                />
              </div>
              <div className="rows-count-badge">
                Showing {filteredAndSortedRows.length} of {rows.length}
              </div>
            </div>
          )}
          {!needsScan && rows.length > 0 && (
            <div style={{ padding: "4px 0 12px" }}>
              <button className="toggle-filter-btn" onClick={() => setShowPnl(!showPnl)} style={{ fontSize: "12px" }}>
                📊 Period P&L Summary {showPnl ? "▲" : "▼"}
              </button>
              {showPnl && (
                <div style={{ marginTop: "10px", padding: "12px 14px", borderRadius: "8px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.25)", fontFamily: "monospace", fontSize: "13px", color: "#c9d3df" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
                    <label>From <input type="date" value={pnlFrom} onChange={(e) => setPnlFrom(e.target.value)} style={{ background: "#0f141c", color: "#e6edf5", border: "1px solid #212836", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }} /></label>
                    <label>To <input type="date" value={pnlTo} onChange={(e) => setPnlTo(e.target.value)} style={{ background: "#0f141c", color: "#e6edf5", border: "1px solid #212836", borderRadius: "6px", padding: "4px 8px", fontFamily: "monospace" }} /></label>
                    <button className="toggle-filter-btn" onClick={() => setPnlScope("tab")} style={{ opacity: pnlScope === "tab" ? 1 : 0.5 }}>This module</button>
                    <button className="toggle-filter-btn" onClick={() => setPnlScope("all")} style={{ opacity: pnlScope === "all" ? 1 : 0.5 }}>All 3 modules</button>
                  </div>
                  {allTradesData === null ? (
                    <div style={{ color: "#8e9ba9" }}>Loading trades…</div>
                  ) : pnl && pnl.n > 0 ? (
                    <div>
                      <div style={{ fontSize: "14px", marginBottom: "6px" }}>
                        <strong>{pnl.n}</strong> trades entered ({pnlScope === "all" ? "all 3 modules" : TABS[tab - 1].label}):{" "}
                        <span className="text-success">{pnl.wins} win</span> · <span className="text-danger">{pnl.losses} loss</span> · <strong>{pnl.wr}% win rate</strong>
                      </div>
                      <div>
                        Sum of per-trade returns: <strong className={pnl.sum >= 0 ? "text-success" : "text-danger"}>{pnl.sum >= 0 ? "+" : ""}{pnl.sum.toFixed(1)}%</strong>
                        {"  ·  "}Avg/trade: <strong>{pnl.avg >= 0 ? "+" : ""}{pnl.avg.toFixed(2)}%</strong>
                        {"  ·  "}Best: <span className="text-success">+{pnl.best.toFixed(1)}%</span>
                        {"  ·  "}Worst: <span className="text-danger">{pnl.worst.toFixed(1)}%</span>
                      </div>
                      <div style={{ color: "#8e9ba9", fontSize: "11px", marginTop: "8px" }}>
                        Note: “Sum of returns” assumes 1 equal unit per trade — NOT a real compounded portfolio return (trades overlap; ignores position sizing, costs, slippage). Rough edge tally, not account P&L.
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "#8e9ba9" }}>No trades entered between {pnlFrom} and {pnlTo}. (If it says this for every range, redeploy so alltrades.json is generated.)</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="state">
            <div className="spinner" />
            Loading ledger database...
          </div>
        ) : needsScan ? (
          <div className="state scan-cta flex flex-col items-center justify-center p-12 text-center">
            <div className="text-xl font-bold text-white mb-2">
              {meta?.stale ? "Cache outdated — rebuild required" : "No analysis cache found"}
            </div>
            <p className="text-sm text-[#8e9ba9] max-w-md mb-6">
              {meta?.stale
                ? `Your cached data was built with older scan rules and no longer matches the current gate (${meta.reason || ""}). Rebuild to refresh.`
                : "Run the Nifty 500 multi-strategy scanner now to build the high-fidelity backtest database."}
            </p>
            {import.meta.env.DEV ? (
              <>
                <button 
                  type="button"
                  className="bg-gradient-to-r from-[#fbbf24] to-[#d97706] text-[#080b11] font-extrabold px-6 py-3 rounded-lg text-base shadow-[0_4px_16px_rgba(251,191,36,0.3)] hover:scale-[1.03] transition-all cursor-pointer mb-6"
                  onClick={startScanning}
                >
                  🚀 Run Multi-Strategy Scan Now
                </button>
                <div className="commands-box border border-[#212836] bg-[#0f141c]/40 p-4 rounded-lg max-w-md w-full text-left font-mono text-xs text-[#8e9ba9]">
                  <div className="mb-2">
                    <span className="text-[#fbbf24]"># Or execute manually in terminal:</span>
                  </div>
                  <div className="flex justify-between items-center mb-1">
                    <span>Fast demo scan:</span>
                    <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan:demo</code>
                  </div>
                  <div className="flex justify-between items-center">
                    <span>Full-history scan:</span>
                    <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan</code>
                  </div>
                </div>
              </>
            ) : (
              <div className="commands-box border border-[#212836] bg-[#0f141c]/40 p-4 rounded-lg max-w-md w-full text-left font-mono text-xs text-[#8e9ba9]">
                <div className="mb-2">
                  <span className="text-[#fbbf24]"># This deployment serves a pre-built cache.</span>
                </div>
                <div className="mb-1">Generate &amp; commit it locally, then redeploy:</div>
                <div className="flex justify-between items-center">
                  <span>Build cache:</span>
                  <code className="bg-[#151b27] px-2 py-0.5 rounded text-white font-semibold">npm run scan</code>
                </div>
              </div>
            )}
          </div>
        ) : filteredAndSortedRows.length === 0 ? (
          <div className="state empty-state">
            {rows.length === 0 ? (
              <>
                <div className="big">Zero stocks cleared the gate</div>
                <p>
                  Applying gate constraints: Win Rate &ge; {g ? g.minWinRate * 100 : 60}% and Profit Factor &ge;{" "}
                  {g ? g.minProfitFactor : 2} with {g ? g.minOosTrades : 10}+ minimum trades.
                </p>
              </>
            ) : (
              <>
                <div className="big">No matches in this view</div>
                <p>
                  {rows.length} stock{rows.length === 1 ? "" : "s"} cleared the gate, but none match your current filters
                  {liveOnly ? " — no LIVE entry signal in the last 5 sessions" : ""}. Clear filters to see them.
                </p>
              </>
            )}
            {(searchQuery || liveOnly) && (
              <button
                className="reset-filters-btn"
                onClick={() => {
                  setSearchQuery("");
                  setLiveOnly(false);
                }}
              >
                Reset Filters
              </button>
            )}
          </div>
        ) : (
          <Ledger
            rows={filteredAndSortedRows}
            showStrategy={tab !== 2}
            sortField={sortField}
            sortAsc={sortAsc}
            onSort={handleSort}
            historyStart={historyStart}
            strictHighlight={tab === 2 && m2Strict}
          />
        )}

        {/* Module 3 breadth */}
        {!loading && !needsScan && tab === 3 && meta?.module3?.breadth && (
          <div className="cards">
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h4>Robustness by breadth — gate-passes across universe</h4>
              <div className="bars-container">
                {meta.module3.breadth.slice(0, 8).map((b) => {
                  const max = Math.max(1, ...meta.module3!.breadth.map((x) => x.gatePasses));
                  return (
                    <div className="bar-row" key={b.label}>
                      <span className="bar-label">{b.label}</span>
                      <div className="bar-track">
                        <span
                          className="bar-fill"
                          style={{ width: `${(b.gatePasses / max) * 100}%` }}
                        />
                      </div>
                      <span className="bar-val">
                        <strong className="text-gold">{b.gatePasses}</strong> stocks · PF{" "}
                        <strong>{b.medianPF}</strong>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Module 2 condition mining */}
        {!loading && !needsScan && tab === 2 && meta?.roundingBottomConditions && (
          <div className="cards">
            <ConditionCard data={meta.roundingBottomConditions.byDepth} />
            <ConditionCard data={meta.roundingBottomConditions.byDuration} />
          </div>
        )}
      </section>

      {/* Real-time Scan Terminal overlay */}
      {scanStatus.isScanning && (
        <div className="fixed inset-0 bg-[#080b11]/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f141c] border border-[#212836] rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-[#181f2c] flex justify-between items-center bg-[#151b27]">
              <div className="flex items-center gap-3">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#fbbf24] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-[#fbbf24]"></span>
                </span>
                <span className="font-bold tracking-tight text-white text-base">High-Fidelity Engine Scanning...</span>
              </div>
              <span className="font-mono text-xs text-[#8e9ba9] bg-[#212836] px-2.5 py-1 rounded">
                Scanned: {scanStatus.scanned}
              </span>
            </div>

            {/* Progress Panel */}
            <div className="p-5 border-b border-[#181f2c] bg-[#111622]/40">
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span className="text-[#8e9ba9]">Processing: <strong className="text-white font-semibold">{scanStatus.currentSymbol}</strong></span>
                <span className="text-[#fbbf24] font-mono font-bold">{scanStatus.progress}%</span>
              </div>
              <div className="w-full bg-[#181f2c] h-3.5 rounded-full overflow-hidden p-[2px]">
                <div 
                  className="bg-gradient-to-r from-[#fbbf24] to-[#10b981] h-full rounded-full transition-all duration-300 shadow-[0_0_12px_rgba(251,191,36,0.3)]"
                  style={{ width: `${scanStatus.progress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-[#576575] mt-3 font-mono">
                <span>Indicators: 10 technical metrics/stock</span>
                <span>Cleared Gates: <strong className="text-[#10b981]">{scanStatus.passedCount} stocks</strong></span>
              </div>
            </div>

            {/* Terminal Console */}
            <div className="flex-1 p-4 overflow-y-auto bg-[#05070a] font-mono text-xs text-[#10b981] min-h-[250px] max-h-[350px] leading-relaxed flex flex-col-reverse rounded-b-lg">
              <div>
                {scanStatus.logs.slice().reverse().map((logLine, idx) => (
                  <div key={idx} className={`py-0.5 ${logLine.includes("[AI OPTIMIZER PASS]") ? "text-[#fbbf24] font-bold" : logLine.includes("[ROUNDING") ? "text-[#3b82f6] font-bold" : logLine.includes("✅") ? "text-[#10b981] font-bold" : "text-[#8e9ba9]"}`}>
                    <span className="text-[#576575] mr-2">[{new Date().toLocaleTimeString()}]</span>
                    {logLine}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionCard({ data }: { data: Bucketed }) {
  const max = Math.max(1, ...data.buckets.map((b) => b.winRatePct));
  return (
    <div className="card">
      <h4>Best conditions · {data.label}</h4>
      <div className="bars-container">
        {data.buckets.map((b) => (
          <div className="bar-row" key={b.range}>
            <span className="bar-label">{b.range}</span>
            <div className="bar-track">
              <span
                className="bar-fill success"
                style={{ width: `${(b.winRatePct / max) * 100}%` }}
              />
            </div>
            <span className="bar-val">
              <strong>{b.winRatePct}%</strong> win (n{b.trades})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
