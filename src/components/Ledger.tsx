import React, { useState } from "react";

export interface TradeRecord {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  win: boolean;
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
}

interface LedgerProps {
  rows: LedgerRow[];
  showStrategy: boolean;
  sortField: keyof LedgerRow | null;
  sortAsc: boolean;
  onSort: (field: keyof LedgerRow) => void;
  historyStart: string; // YYYY-MM-DD — only signals on/after this date are shown
  strictHighlight?: boolean; // M2: badge rows meeting the strict 15-trade / PF 2.5 standard
}

const fmt = (v: number | null, d = 2) => (v === null || v === undefined ? "—" : v.toFixed(d));

export function Ledger({ rows, showStrategy, sortField, sortAsc, onSort, historyStart, strictHighlight }: LedgerProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tradesCache, setTradesCache] = useState<Record<string, TradeRecord[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

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

  const renderTodayPlan = (r: LedgerRow) => {
    if (r.liveSignal && r.livePrice) {
      const entry = r.livePrice;
      const stop = Math.round(entry * 0.92);
      const target = Math.round(entry * (1 + r.avgReturnPct / 100));
      const risk = entry - stop;
      const reward = target - entry;
      const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
      return (
        <div style={{ marginBottom: "12px", padding: "10px 12px", borderRadius: "8px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)", fontFamily: "monospace", fontSize: "12.5px", color: "#c9f5d6" }}>
          <div style={{ fontWeight: 700, color: "#22c55e", marginBottom: "4px" }}>📍 LIVE setup (as of latest close)</div>
          <div>Entry zone ≈ <strong>₹{entry}</strong> · Stop-loss <strong>₹{stop}</strong> (−8%) · Target ≈ <strong>₹{target}</strong> (+{r.avgReturnPct.toFixed(1)}% avg) · R:R ≈ 1:{rr}</div>
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
            const returnVal = r.lastReturnPct;
            const rowKey = r.symbol + r.strategyId;
            const isOpen = expanded === rowKey;

            let returnClass = "badge-neutral";
            if (returnVal !== null) {
              returnClass = returnVal >= 0 ? "badge-success" : "badge-danger";
            }

            const avgReturnClass = r.avgReturnPct >= 0 ? "text-success" : "text-danger";
            const isStrict = r.numTrades >= 15 && r.profitFactor >= 2.5 && r.winRatePct >= 60;
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
                      {returnVal === null ? "—" : (returnVal >= 0 ? "+" : "") + fmt(returnVal) + "%"}
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
