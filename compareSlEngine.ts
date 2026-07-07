// ============================================================================
// compareSlEngine.ts — REUSABLE exit-scheme comparison engine
// ----------------------------------------------------------------------------
// Dashboard ko BILKUL nahi chhoota. Isse do jagah use kar sakte ho:
//   1) API route (server.ts me /api/compare-sl) — poore live universe pe,
//      Render pe deploy karke URL se JSON result milta hai.
//   2) CLI (compare-sl-cli.ts) — apne local machine pe terminal me table.
// Same entries (M1 StochRSI + M3 Best-Overall) par 7 exit schemes test hote hain,
// taaki current "8% flat SL" ka data-backed comparison mil sake.
// ============================================================================

import { fetchStockData, calculateRSI, type OHLCV } from "./scan.ts";
import fs from "fs";
import path from "path";

const COST_PCT = 0.2;
const NO_LOSS_PF_CAP = 10.0;

// ---- indicators (scan.ts se hu-ba-hu, taaki entries identical rahein) ----
function calculateEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  if (closes.length === 0) return [];
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) { sum += closes[i]; ema.push(sum / (i + 1)); }
  for (let i = period; i < closes.length; i++) ema.push(closes[i] * multiplier + ema[i - 1] * (1 - multiplier));
  return ema;
}
function calculateMACD(closes: number[]) {
  const ema12 = calculateEMA(closes, 12), ema26 = calculateEMA(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] || 0) - (ema26[i] || 0));
  const signalLine = calculateEMA(macdLine, 9);
  const histogram = closes.map((_, i) => macdLine[i] - (signalLine[i] || 0));
  return { macdLine, signalLine, histogram };
}
function calculateStochasticRSI(rsi: number[], period = 14, kPeriod = 3, dPeriod = 3) {
  const stochRSI: number[] = [];
  for (let i = 0; i < rsi.length; i++) {
    if (i < period - 1) { stochRSI.push(50); continue; }
    const slice = rsi.slice(i - period + 1, i + 1);
    const mn = Math.min(...slice), mx = Math.max(...slice), den = mx - mn;
    stochRSI.push(den === 0 ? 50 : ((rsi[i] - mn) / den) * 100);
  }
  const k = calculateEMA(stochRSI, kPeriod);
  const d = calculateEMA(k, dPeriod);
  return { k, d };
}
function calculateADX(data: OHLCV[], period = 14): number[] {
  if (data.length <= period * 2) return Array(data.length).fill(25);
  const adx = Array(data.length).fill(25);
  const tr = [0], plusDM = [0], minusDM = [0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  let trS = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let pS = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let mS = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  const dxList = Array(period).fill(0);
  for (let i = period; i < data.length; i++) {
    if (i > period) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + plusDM[i]; mS = mS - mS / period + minusDM[i]; }
    const pDI = trS === 0 ? 0 : (pS / trS) * 100, mDI = trS === 0 ? 0 : (mS / trS) * 100;
    const sum = pDI + mDI, diff = Math.abs(pDI - mDI);
    dxList.push(sum === 0 ? 0 : (diff / sum) * 100);
  }
  let adxSum = dxList.slice(period, period * 2).reduce((a, b) => a + b, 0);
  adx[period * 2 - 1] = adxSum / period;
  for (let i = period * 2; i < data.length; i++) { adxSum = adxSum - adxSum / period + (dxList[i] || 0); adx[i] = adxSum / period; }
  return adx;
}
function calculateATR(data: OHLCV[], period = 14): number[] {
  const atr = Array(data.length).fill(0);
  if (data.length < period + 1) return atr;
  const tr: number[] = [0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sum = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  atr[period] = sum / period;
  for (let i = period + 1; i < data.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

// ---- exit schemes ----
type Scheme = { key: string; label: string; levels: (entry: number, atr: number, avgRet: number) => { stop: number; target: number } | null };
export const SCHEMES: Scheme[] = [
  { key: "IND",      label: "Indicator exit (current dashboard)",   levels: () => null },
  { key: "SL8_AVG",  label: "8% SL + avg-return target (callout)",  levels: (e, _a, av) => ({ stop: e * 0.92, target: e * (1 + Math.max(av, 1) / 100) }) },
  { key: "SL8_2R",   label: "8% SL + fixed 1:2 R:R",                levels: (e) => ({ stop: e * 0.92, target: e * (1 + 0.08 * 2) }) },
  { key: "SL5_15",   label: "5% SL + 15% target (m2 style)",        levels: (e) => ({ stop: e * 0.95, target: e * 1.15 }) },
  { key: "ATR2_3",   label: "2x ATR SL + 3x ATR target (~1:1.5)",   levels: (e, a) => ({ stop: e - 2 * a, target: e + 3 * a }) },
  { key: "ATR25_2R", label: "2.5x ATR SL + fixed 1:2 R:R",          levels: (e, a) => ({ stop: e - 2.5 * a, target: e + 2.5 * a * 2 }) },
  { key: "ATR3_45",  label: "3x ATR SL + 4.5x ATR target (~1:1.5)", levels: (e, a) => ({ stop: e - 3 * a, target: e + 4.5 * a }) },
];

type StratId = "m1_stoch_rsi" | "m3_best_overall";
function entryTrigger(id: StratId, i: number, ind: any): boolean {
  const { ema9, ema21, macd, stochRsi, adx } = ind;
  if (id === "m1_stoch_rsi")
    return (stochRsi.k[i] || 0) > (stochRsi.d[i] || 0) && (stochRsi.k[i - 1] || 0) <= (stochRsi.d[i - 1] || 0) && (stochRsi.k[i] || 0) < 20 && (adx[i] || 0) > 25;
  return (ema9[i] || 0) > (ema21[i] || 0) && (ema9[i - 1] || 0) <= (ema21[i - 1] || 0) && (macd.macdLine[i] || 0) > (macd.signalLine[i] || 0);
}
function indicatorExit(id: StratId, i: number, ind: any): boolean {
  const { ema9, ema21, macd, stochRsi } = ind;
  if (id === "m1_stoch_rsi") return (stochRsi.k[i] || 0) < (stochRsi.d[i] || 0) && (stochRsi.k[i] || 0) > 80;
  return (ema9[i] || 0) < (ema21[i] || 0) || (macd.macdLine[i] || 0) < (macd.signalLine[i] || 0);
}

interface TradeOut { ret: number; rr: number | null }
function backtest(id: StratId, data: OHLCV[], ind: any, scheme: Scheme): TradeOut[] {
  const opens = data.map(d => d.open), highs = data.map(d => d.high), lows = data.map(d => d.low), closes = data.map(d => d.close);
  const atr = ind.atr as number[];
  const out: TradeOut[] = [];
  let inPos = false, entry = 0, slLvl = 0, tgtLvl = 0, useLevels = false, plannedRR: number | null = null, pending = false;

  for (let i = 50; i < data.length; i++) {
    if (!inPos) {
      if (pending) {
        inPos = true; entry = opens[i]; pending = false;
        const lv = scheme.levels(entry, atr[i] || (entry * 0.03), ind.avgRetForScheme ?? 5);
        if (lv) { useLevels = true; slLvl = lv.stop; tgtLvl = lv.target; plannedRR = (tgtLvl - entry) > 0 && (entry - slLvl) > 0 ? (tgtLvl - entry) / (entry - slLvl) : null; }
        else { useLevels = false; plannedRR = null; }
        continue;
      }
      if (entryTrigger(id, i, ind) && i < data.length - 1) pending = true;
    } else {
      let exit = false, exitPrice = closes[i];
      if (useLevels) {
        if (opens[i] <= slLvl) { exit = true; exitPrice = opens[i]; }
        else if (lows[i] <= slLvl) { exit = true; exitPrice = slLvl; }
        else if (opens[i] >= tgtLvl) { exit = true; exitPrice = opens[i]; }
        else if (highs[i] >= tgtLvl) { exit = true; exitPrice = tgtLvl; }
      } else if (indicatorExit(id, i, ind)) { exit = true; exitPrice = closes[i]; }
      if (exit || i === data.length - 1) {
        if (!exit) exitPrice = closes[i];
        inPos = false;
        out.push({ ret: ((exitPrice - entry) / entry) * 100 - COST_PCT, rr: plannedRR });
      }
    }
  }
  return out;
}

export interface SchemeAgg {
  key: string; label: string; trades: number; winRatePct: number; profitFactor: number;
  avgReturnPct: number; expectancyPct: number; avgWinPct: number; avgLossPct: number;
  maxDrawdownPct: number; avgPlannedRR: number | null;
}
function agg(trades: TradeOut[]): Omit<SchemeAgg, "key" | "label"> | null {
  const n = trades.length;
  if (n === 0) return null;
  const rets = trades.map(t => t.ret);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = gl === 0 ? (gp > 0 ? NO_LOSS_PF_CAP : 1) : Math.min(gp / gl, NO_LOSS_PF_CAP);
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const rrs = trades.map(t => t.rr).filter((x): x is number => x != null);
  let bal = 100, peak = 100, maxDD = 0;
  for (const r of rets) { bal *= (1 + r / 100); if (bal > peak) peak = bal; const dd = ((peak - bal) / peak) * 100; if (dd > maxDD) maxDD = dd; }
  return {
    trades: n,
    winRatePct: +(wins.length / n * 100).toFixed(1),
    profitFactor: +pf.toFixed(2),
    avgReturnPct: +avg.toFixed(2),
    expectancyPct: +avg.toFixed(2),
    avgWinPct: +(wins.length ? gp / wins.length : 0).toFixed(2),
    avgLossPct: +(losses.length ? -gl / losses.length : 0).toFixed(2),
    maxDrawdownPct: +maxDD.toFixed(1),
    avgPlannedRR: rrs.length ? +(rrs.reduce((a, b) => a + b, 0) / rrs.length).toFixed(2) : null,
  };
}

export interface CompareResult {
  ok: true;
  universeRequested: number;
  universeUsed: number;
  skipped: string[];
  elapsedSec: number;
  strategies: {
    id: StratId;
    label: string;
    schemes: SchemeAgg[];
    best: { key: string; label: string; reason: string } | null;
  }[];
  note: string;
}

export async function runCompareSl(
  universe: { symbol: string; name: string }[],
  onProgress?: (done: number, total: number, sym: string) => void
): Promise<CompareResult> {
  const t0 = Date.now();
  const strategies: StratId[] = ["m1_stoch_rsi", "m3_best_overall"];
  const bucket: Record<string, Record<string, TradeOut[]>> = {};
  for (const s of strategies) { bucket[s] = {}; for (const sc of SCHEMES) bucket[s][sc.key] = []; }

  let done = 0, used = 0;
  const skipped: string[] = [];

  // Parallel batches (avoid hammering Yahoo + keep the Render request from timing out)
  const BATCH = 12;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    await Promise.all(batch.map(async (t) => {
      let data: OHLCV[] | null = null;
      const cachedPath = path.join(process.cwd(), "data", "ohlcv", `${t.symbol}.json`);
      try {
        if (fs.existsSync(cachedPath)) {
          const raw = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
          data = raw.d.map((d: string, idx: number) => ({
            date: d,
            open: raw.o[idx],
            high: raw.h[idx],
            low: raw.l[idx],
            close: raw.c[idx],
            volume: raw.v ? raw.v[idx] : 0
          }));
        }
      } catch (e) {
        // ignore and fallback
      }

      if (!data) {
        data = await fetchStockData(t.symbol);
      }

      done++;
      if (onProgress) onProgress(done, universe.length, t.symbol);
      if (!data || data.length < 120) { skipped.push(t.symbol); return; }
      used++;
      const closes = data.map(d => d.close);
      const rsi = calculateRSI(closes, 14);
      const ind = {
        ema9: calculateEMA(closes, 9), ema21: calculateEMA(closes, 21),
        macd: calculateMACD(closes), stochRsi: calculateStochasticRSI(rsi, 14, 3, 3),
        adx: calculateADX(data, 14), atr: calculateATR(data, 14),
      };
      for (const id of strategies) {
        const baseTrades = backtest(id, data, { ...ind, avgRetForScheme: 5 }, SCHEMES[0]);
        const baseAvg = baseTrades.length ? baseTrades.reduce((a, b) => a + b.ret, 0) / baseTrades.length : 5;
        const avgRet = Math.max(baseAvg, 1);
        for (const sc of SCHEMES) {
          const tr = backtest(id, data, { ...ind, avgRetForScheme: avgRet }, sc);
          bucket[id][sc.key].push(...tr);
        }
      }
    }));
  }

  const stratName: Record<StratId, string> = { m1_stoch_rsi: "M1 · Stochastic RSI Trend Filter", m3_best_overall: "M3 · Best Overall Edge (EMA+MACD)" };
  const strategiesOut = strategies.map((id) => {
    const schemes: SchemeAgg[] = SCHEMES.map(sc => {
      const a = agg(bucket[id][sc.key]);
      return a ? { key: sc.key, label: sc.label, ...a } : { key: sc.key, label: sc.label, trades: 0, winRatePct: 0, profitFactor: 0, avgReturnPct: 0, expectancyPct: 0, avgWinPct: 0, avgLossPct: 0, maxDrawdownPct: 0, avgPlannedRR: null };
    });
    const withTrades = schemes.filter(s => s.trades > 0);
    let best: { key: string; label: string; reason: string } | null = null;
    if (withTrades.length) {
      const top = [...withTrades].sort((a, b) => b.expectancyPct - a.expectancyPct)[0];
      const ind = schemes.find(s => s.key === "IND");
      const beatsIndicator = ind && ind.trades > 0 ? (top.expectancyPct > ind.expectancyPct && top.profitFactor > ind.profitFactor) : true;
      best = {
        key: top.key, label: top.label,
        reason: beatsIndicator
          ? `Highest expectancy (${top.expectancyPct}%/trade) AND better PF (${top.profitFactor}) than current indicator-exit — worth switching.`
          : `Highest expectancy (${top.expectancyPct}%/trade) but does NOT clearly beat current indicator-exit on PF — keep current unless you value the simpler fixed-R:R structure.`,
      };
    }
    return { id, label: stratName[id], schemes, best };
  });

  return {
    ok: true,
    universeRequested: universe.length,
    universeUsed: used,
    skipped,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    strategies: strategiesOut,
    note: "Entries identical across all schemes (same signals) — only the exit rule (SL/target) differs. Net of 0.2% cost/trade. Expectancy is the number that matters most; win% alone can mislead.",
  };
}
