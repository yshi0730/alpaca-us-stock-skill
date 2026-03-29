/**
 * Monitor Daemon — runs as a forked child process.
 *
 * Responsibilities:
 * 1. WebSocket: Stream real-time prices for watched symbols
 * 2. Cron: Periodically check positions, run strategy conditions
 * 3. Alert Engine: Match rules → write alerts to SQLite + JSONL
 *
 * Communication: parent ↔ child via process.send / process.on('message')
 * Alerts are written to SQLite so the MCP server can read them.
 */

import cron from "node-cron";
import { v4 as uuid } from "uuid";
import { AlpacaClient } from "../src/alpaca/client.js";
import { AlpacaStream, type StreamEvent } from "../src/alpaca/streaming.js";
import type { TradingMode } from "../src/alpaca/types.js";
import { getDb } from "../src/storage/db.js";
import {
  getAlertRules,
  recordAlert,
  savePositionSnapshot,
  listStrategies,
} from "../src/storage/queries.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = resolve(__dirname, "../data/alerts.jsonl");

// Config from env
const apiKey = process.env.ALPACA_API_KEY!;
const apiSecret = process.env.ALPACA_API_SECRET!;
const mode = (process.env.ALPACA_MODE || "paper") as TradingMode;
const extraSymbols = (process.env.MONITOR_SYMBOLS || "").split(",").filter(Boolean);
const cronInterval = parseInt(process.env.MONITOR_CRON_INTERVAL || "5");

const client = new AlpacaClient({ apiKey, apiSecret, mode });
const stream = new AlpacaStream(apiKey, apiSecret, mode);

// Latest prices from WebSocket
const latestPrices: Record<string, number> = {};
const prevPrices: Record<string, number> = {};

// ── WebSocket Handler ──

stream.on((event: StreamEvent) => {
  if (event.type === "trade") {
    if (latestPrices[event.symbol] !== undefined) {
      prevPrices[event.symbol] = latestPrices[event.symbol];
    }
    latestPrices[event.symbol] = event.price;
    checkAlertRules(event.symbol, event.price);
  } else if (event.type === "connected") {
    console.log("[monitor] WebSocket connected");
  } else if (event.type === "disconnected") {
    console.log("[monitor] WebSocket disconnected, will reconnect");
  }
});

// ── Alert Check ──

function checkAlertRules(symbol: string, price: number): void {
  const rules = getAlertRules(true);
  for (const rule of rules) {
    if (rule.symbol !== symbol) continue;
    const { indicator, op, value } = rule.condition;

    let actual: number | undefined;
    if (indicator === "price") {
      actual = price;
    } else if (indicator === "price_change_pct") {
      const prev = prevPrices[symbol];
      if (prev) actual = ((price - prev) / prev) * 100;
    }

    if (actual === undefined) continue;

    const triggered =
      (op === "gt" && actual > value) ||
      (op === "lt" && actual < value) ||
      (op === "gte" && actual >= value) ||
      (op === "lte" && actual <= value);

    if (triggered) {
      const alert = {
        id: uuid(),
        rule_id: rule.id,
        symbol,
        message: `${symbol} ${indicator} = ${actual.toFixed(2)} (${op} ${value})`,
        data: { price, indicator, op, value, actual },
      };

      recordAlert(alert);

      // Also write to JSONL for fast file-based reading
      try {
        mkdirSync(dirname(ALERTS_FILE), { recursive: true });
        appendFileSync(ALERTS_FILE, JSON.stringify({ ...alert, created_at: new Date().toISOString() }) + "\n");
      } catch {
        // ignore file errors
      }

      console.log(`[monitor] ALERT: ${alert.message}`);
    }
  }
}

// ── Cron: Position Snapshot ──

cron.schedule(`*/${cronInterval} * * * *`, async () => {
  try {
    const [account, positions] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
    ]);

    const totalEquity = parseFloat(account.equity);
    const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);

    savePositionSnapshot({
      positions: positions.map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        price: p.current_price,
        pnl: p.unrealized_pl,
      })),
      total_equity: totalEquity,
      total_pnl: totalPnl,
    });

    console.log(`[monitor] Snapshot: equity=$${totalEquity.toFixed(2)}, pnl=$${totalPnl.toFixed(2)}`);
  } catch (err) {
    console.error("[monitor] Snapshot error:", err);
  }
});

// ── Start ──

async function start(): Promise<void> {
  console.log(`[monitor] Starting monitor daemon (mode=${mode}, interval=${cronInterval}m)`);

  // Collect symbols to watch: positions + active strategies + extra symbols
  const symbolSet = new Set<string>(extraSymbols.map((s) => s.toUpperCase()));

  try {
    const positions = await client.getPositions();
    for (const p of positions) symbolSet.add(p.symbol);
  } catch {
    // ignore
  }

  const strategies = listStrategies();
  for (const s of strategies) {
    if (s.is_active) {
      for (const sym of s.universe) symbolSet.add(sym);
    }
  }

  // Always watch major indices
  for (const idx of ["SPY", "QQQ", "DIA"]) symbolSet.add(idx);

  const symbols = [...symbolSet];
  console.log(`[monitor] Watching: ${symbols.join(", ")}`);

  stream.connect();
  stream.subscribe(symbols);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[monitor] Shutting down...");
  stream.disconnect();
  process.exit(0);
});

process.on("SIGINT", () => {
  stream.disconnect();
  process.exit(0);
});

start().catch((err) => {
  console.error("[monitor] Fatal:", err);
  process.exit(1);
});
