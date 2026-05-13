/**
 * Monitor daemon compiled with the MCP server.
 *
 * Responsibilities:
 * 1. WebSocket: stream real-time prices for watched symbols.
 * 2. Cron: periodically snapshot positions and run strategy/risk checks.
 * 3. Alert engine: match rules and write alerts to SQLite + JSONL.
 */

import cron from "node-cron";
import { v4 as uuid } from "uuid";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AlpacaClient } from "./alpaca/client.js";
import { AlpacaStream, type StreamEvent } from "./alpaca/streaming.js";
import type { TradingMode } from "./alpaca/types.js";
import {
  getAlertRules,
  recordAlert,
  savePositionSnapshot,
  listStrategies,
} from "./storage/queries.js";
import { formatMoney, formatQty, toFiniteNumber } from "./precision.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALERTS_FILE = resolve(__dirname, "../data/alerts.jsonl");

const apiKey = process.env.ALPACA_API_KEY!;
const apiSecret = process.env.ALPACA_API_SECRET!;
const mode = (process.env.ALPACA_MODE || "paper") as TradingMode;
const extraSymbols = (process.env.MONITOR_SYMBOLS || "").split(",").filter(Boolean);
const intervalSeconds = Math.max(
  15,
  parseInt(
    process.env.MONITOR_CRON_INTERVAL_SECONDS ||
      String(parseInt(process.env.MONITOR_CRON_INTERVAL || "1", 10) * 60),
    10
  )
);

const client = new AlpacaClient({ apiKey, apiSecret, mode });
const stream = new AlpacaStream(apiKey, apiSecret, mode);

const latestPrices: Record<string, number> = {};
const prevPrices: Record<string, number> = {};

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
        message: `${symbol} ${indicator} = ${formatQty(actual)} (${op} ${formatQty(value)})`,
        data: { price, indicator, op, value, actual },
      };

      recordAlert(alert);

      try {
        mkdirSync(dirname(ALERTS_FILE), { recursive: true });
        appendFileSync(ALERTS_FILE, JSON.stringify({ ...alert, created_at: new Date().toISOString() }) + "\n");
      } catch {
        // Alerts are already persisted in SQLite; file logging is best-effort.
      }

      console.log(`[monitor] ALERT: ${alert.message}`);
    }
  }
}

const cronExpression =
  intervalSeconds < 60
    ? `*/${intervalSeconds} * * * * *`
    : `*/${Math.max(1, Math.round(intervalSeconds / 60))} * * * *`;

cron.schedule(cronExpression, async () => {
  try {
    const [account, positions] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
    ]);

    const totalEquity = toFiniteNumber(account.equity);
    const totalPnl = positions.reduce((s, p) => s + toFiniteNumber(p.unrealized_pl), 0);

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

    console.log(`[monitor] Snapshot: equity=${formatMoney(totalEquity)}, pnl=${formatMoney(totalPnl)}`);
  } catch (err) {
    console.error("[monitor] Snapshot error:", err);
  }
});

async function start(): Promise<void> {
  console.log(`[monitor] Starting monitor daemon (mode=${mode}, interval=${intervalSeconds}s)`);

  const symbolSet = new Set<string>(extraSymbols.map((s) => s.toUpperCase()));

  try {
    const positions = await client.getPositions();
    for (const p of positions) symbolSet.add(p.symbol);
  } catch {
    // Keep booting even if account calls are temporarily unavailable.
  }

  const strategies = listStrategies();
  for (const s of strategies) {
    if (s.is_active) {
      for (const sym of s.universe) symbolSet.add(sym);
    }
  }

  for (const idx of ["SPY", "QQQ", "DIA"]) symbolSet.add(idx);

  const symbols = [...symbolSet];
  console.log(`[monitor] Watching: ${symbols.join(", ")}`);

  stream.connect();
  stream.subscribe(symbols);
}

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
