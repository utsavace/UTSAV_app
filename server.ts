import express from "express";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { runScan, NO_LOSS_PF_CAP } from "./scan.ts";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CACHE = path.join(process.cwd(), "public", "cache");

app.use(express.json());

interface ScanStatus {
  isScanning: boolean;
  progress: number;
  scanned: number;
  currentSymbol: string;
  passedCount: number;
  logs: string[];
}

let scanStatus: ScanStatus = {
  isScanning: false,
  progress: 0,
  scanned: 0,
  currentSymbol: "",
  passedCount: 0,
  logs: []
};

function readCache(name: string) {
  const p = path.join(CACHE, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Verifies cached rows actually obey the gate recorded in meta. Stops a stale cache
// (e.g. rows built under an old MIN_TRADES/PF rule) from being served and contradicting
// its own meta. If invalid, callers are told needsScan so the UI prompts a rebuild.
function validateCache(): { valid: boolean; reason?: string } {
  const meta = readCache("meta.json");
  if (!meta || meta.needsScan) return { valid: false, reason: "no meta" };
  const g = meta.gate;
  if (!g) return { valid: false, reason: "no gate in meta" };

  const minWR = (g.minWinRate ?? 0) * 100;
  // Base gate = what module 2 rows satisfy; strict gate = modules 1 & 3.
  // Validating everything against ONE gate previously self-invalidated fresh caches
  // whenever an M2 row sat between the base and strict thresholds.
  const baseT = g.minOosTrades ?? 0;
  const basePF = g.minProfitFactor ?? 0;
  const strictT = g.strict?.minOosTrades ?? baseT;
  const strictPF = g.strict?.minProfitFactor ?? basePF;

  for (const n of ["1", "2", "3"]) {
    const isStrictModule = n !== "2";
    const minT = isStrictModule ? strictT : baseT;
    const minPF = isStrictModule ? strictPF : basePF;

    const rows = readCache(`module${n}.json`);
    if (rows === null) return { valid: false, reason: `module${n} missing` };
    for (const r of rows) {
      if (r.numTrades < minT)
        return { valid: false, reason: `m${n} ${r.symbol}: ${r.numTrades} trades < gate ${minT}` };
      if (r.winRatePct < minWR - 0.01)
        return { valid: false, reason: `m${n} ${r.symbol}: WR ${r.winRatePct} < gate ${minWR}` };
      if (r.profitFactor < minPF - 0.01 || r.profitFactor > NO_LOSS_PF_CAP + 0.01)
        return { valid: false, reason: `m${n} ${r.symbol}: PF ${r.profitFactor} outside [${minPF}, ${NO_LOSS_PF_CAP}]` };
    }
  }
  return { valid: true };
}

app.get("/api/meta", (_req, res) => {
  const meta = readCache("meta.json");
  if (!meta) return res.json({ needsScan: true });
  const check = validateCache();
  if (!check.valid) {
    console.warn(`⚠️ Stale cache ignored → ${check.reason}`);
    return res.json({ needsScan: true, stale: true, reason: check.reason });
  }
  res.json(meta);
});

app.get("/api/module/:n", (req, res) => {
  const n = req.params.n;
  if (!["1", "2", "3"].includes(n)) return res.status(400).json({ error: "module must be 1, 2 or 3" });
  if (!validateCache().valid) return res.json({ needsScan: true, stale: true, rows: [] });
  const data = readCache(`module${n}.json`);
  if (data === null) return res.json({ needsScan: true, rows: [] });
  res.json({ rows: data });
});

app.post("/api/scan/start", async (_req, res) => {
  if (scanStatus.isScanning) {
    return res.json({ status: "already_running" });
  }

  scanStatus = {
    isScanning: true,
    progress: 0,
    scanned: 0,
    currentSymbol: "Starting...",
    passedCount: 0,
    logs: ["Initializing server-side scanner session..."]
  };

  res.json({ status: "started" });

  // Start background scan async so it doesn't block the request
  runScan((progress, scanned, currentSymbol, passedCount, logLine) => {
    scanStatus.progress = progress;
    scanStatus.scanned = scanned;
    scanStatus.currentSymbol = currentSymbol;
    scanStatus.passedCount = passedCount;
    scanStatus.logs.push(logLine);
    if (scanStatus.logs.length > 80) {
      scanStatus.logs.shift(); // Keep logs memory bound
    }
  }).then(() => {
    scanStatus.isScanning = false;
    scanStatus.progress = 100;
    scanStatus.logs.push("🎉 Scan complete. Refreshing edge dashboards.");
  }).catch((err) => {
    scanStatus.isScanning = false;
    scanStatus.logs.push(`❌ Error encountered during scanning: ${err.message || err}`);
  });
});

app.get("/api/scan/status", (_req, res) => {
  res.json(scanStatus);
});

// LOCAL DEV ONLY: commit & push the freshly scanned public/cache so the deployed app can pick it up.
// Disabled in production (serverless containers have no git remote / credentials).
app.post("/api/publish", (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ ok: false, output: "Publish is disabled in production. Run it from local dev." });
  }

  // Check if .git exists to prevent 'fatal: not a git repository' error in workspace environments
  if (!fs.existsSync(path.join(process.cwd(), ".git"))) {
    return res.json({ 
      ok: false, 
      output: "No .git repository found in this workspace. Publishing (git push) is only supported in local development clones. Click 'Fetch Fresh Data' to use live data inside this session." 
    });
  }

  // `git diff --cached --quiet` skips an empty commit; push is a harmless no-op if nothing changed.
  const cmd = `git add public/cache && (git diff --cached --quiet || git commit -m "chore: refresh scan cache") && git push`;
  exec(cmd, { cwd: process.cwd() }, (err, stdout, stderr) => {
    const output = ((stdout || "") + (stderr || "")).trim().slice(-1800);
    if (err) return res.json({ ok: false, output: output || err.message });
    res.json({ ok: true, output: output || "Cache published." });
  });
});

async function start() {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }
  
  app.listen(PORT, "0.0.0.0", () => console.log(`Edge console → http://localhost:${PORT}`));
}

start();
