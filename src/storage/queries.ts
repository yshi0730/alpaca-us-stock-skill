import { v4 as uuid } from "uuid";
import { getDb } from "./db.js";
import { normalizeDecimalString, toFiniteNumber } from "../precision.js";
import type {
  AlertEvent,
  AlertRule,
  BacktestConfig,
  BacktestResult,
  Strategy,
} from "../alpaca/types.js";

// ── Strategies ──

export function saveStrategy(strategy: Omit<Strategy, "created_at" | "updated_at">): Strategy {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO strategies (id, name, description, universe, rules, risk_management, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       universe = excluded.universe,
       rules = excluded.rules,
       risk_management = excluded.risk_management,
       is_active = excluded.is_active,
       updated_at = excluded.updated_at`
  ).run(
    strategy.id,
    strategy.name,
    strategy.description,
    JSON.stringify(strategy.universe),
    JSON.stringify(strategy.rules),
    strategy.risk_management ? JSON.stringify(strategy.risk_management) : null,
    strategy.is_active ? 1 : 0,
    now,
    now
  );
  return { ...strategy, created_at: now, updated_at: now };
}

export function listStrategies(): Strategy[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM strategies ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
  return rows.map(rowToStrategy);
}

export function getStrategy(id: string): Strategy | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToStrategy(row) : null;
}

export function deleteStrategy(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
  return result.changes > 0;
}

function rowToStrategy(row: Record<string, unknown>): Strategy {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    universe: JSON.parse(row.universe as string),
    rules: JSON.parse(row.rules as string),
    risk_management: row.risk_management ? JSON.parse(row.risk_management as string) : undefined,
    is_active: Boolean(row.is_active),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ── Trades ──

export function recordTrade(trade: {
  order_id: string;
  symbol: string;
  side: string;
  qty: number | string;
  price?: number | string;
  total?: number | string;
  strategy_id?: string;
  status: string;
  filled_at?: string;
}): string {
  const db = getDb();
  const id = uuid();
  const qtyText = normalizeDecimalString(trade.qty, 9);
  const priceText = trade.price !== undefined ? normalizeDecimalString(trade.price, 8) : null;
  const totalText = trade.total !== undefined ? normalizeDecimalString(trade.total, 8) : null;
  db.prepare(
    `INSERT INTO trades (id, order_id, symbol, side, qty, qty_text, price, price_text, total, total_text, strategy_id, status, filled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    trade.order_id,
    trade.symbol,
    trade.side,
    toFiniteNumber(qtyText),
    qtyText,
    priceText ? toFiniteNumber(priceText) : null,
    priceText,
    totalText ? toFiniteNumber(totalText) : null,
    totalText,
    trade.strategy_id ?? null,
    trade.status,
    trade.filled_at ?? null
  );
  return id;
}

export function updateTradeStatus(orderId: string, status: string, filledPrice?: number): void {
  const db = getDb();
  if (filledPrice !== undefined) {
    db.prepare(
      "UPDATE trades SET status = ?, price = ?, filled_at = datetime('now') WHERE order_id = ?"
    ).run(status, filledPrice, orderId);
  } else {
    db.prepare("UPDATE trades SET status = ? WHERE order_id = ?").run(status, orderId);
  }
}

export function addTradeNote(tradeId: string, note: string): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE trades SET note = ? WHERE id = ?").run(note, tradeId);
  return result.changes > 0;
}

export function getTradeJournal(params?: {
  start_date?: string;
  end_date?: string;
  symbol?: string;
}): Array<Record<string, unknown>> {
  const db = getDb();
  let sql = "SELECT * FROM trades WHERE 1=1";
  const binds: unknown[] = [];
  if (params?.start_date) {
    sql += " AND created_at >= ?";
    binds.push(params.start_date);
  }
  if (params?.end_date) {
    sql += " AND created_at <= ?";
    binds.push(params.end_date);
  }
  if (params?.symbol) {
    sql += " AND symbol = ?";
    binds.push(params.symbol.toUpperCase());
  }
  sql += " ORDER BY created_at DESC";
  return db.prepare(sql).all(...binds) as Array<Record<string, unknown>>;
}

// ── Alerts ──

export function saveAlertRule(rule: Omit<AlertRule, "last_triggered_at" | "created_at">): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO alert_rules (id, symbol, condition, action, is_active)
     VALUES (?, ?, ?, ?, ?)`
  ).run(rule.id, rule.symbol, JSON.stringify(rule.condition), JSON.stringify(rule.action), rule.is_active ? 1 : 0);
}

export function getAlertRules(activeOnly = false): AlertRule[] {
  const db = getDb();
  const sql = activeOnly
    ? "SELECT * FROM alert_rules WHERE is_active = 1"
    : "SELECT * FROM alert_rules";
  const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    symbol: r.symbol as string,
    condition: JSON.parse(r.condition as string),
    action: JSON.parse(r.action as string),
    is_active: Boolean(r.is_active),
    last_triggered_at: r.last_triggered_at as string | null,
    created_at: r.created_at as string,
  }));
}

export function removeAlertRule(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function recordAlert(event: Omit<AlertEvent, "acknowledged" | "created_at">): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO alert_history (id, rule_id, symbol, message, data) VALUES (?, ?, ?, ?, ?)`
  ).run(event.id, event.rule_id, event.symbol, event.message, JSON.stringify(event.data));
  db.prepare(
    "UPDATE alert_rules SET last_triggered_at = datetime('now') WHERE id = ?"
  ).run(event.rule_id);
}

export function getUnacknowledgedAlerts(): AlertEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM alert_history WHERE acknowledged = 0 ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    rule_id: r.rule_id as string,
    symbol: r.symbol as string,
    message: r.message as string,
    data: r.data ? JSON.parse(r.data as string) : {},
    acknowledged: false,
    created_at: r.created_at as string,
  }));
}

export function acknowledgeAlerts(ids?: string[]): void {
  const db = getDb();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE alert_history SET acknowledged = 1 WHERE id IN (${placeholders})`).run(
      ...ids
    );
  } else {
    db.prepare("UPDATE alert_history SET acknowledged = 1 WHERE acknowledged = 0").run();
  }
}

// ── Position Snapshots ──

export function savePositionSnapshot(snapshot: {
  positions: unknown;
  total_equity: number;
  total_pnl: number;
}): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO position_snapshots (snapshot, total_equity, total_pnl) VALUES (?, ?, ?)"
  ).run(JSON.stringify(snapshot.positions), snapshot.total_equity, snapshot.total_pnl);
}

export function getPositionSnapshots(limit = 100): Array<{
  total_equity: number;
  total_pnl: number;
  created_at: string;
}> {
  const db = getDb();
  return db
    .prepare(
      "SELECT total_equity, total_pnl, created_at FROM position_snapshots ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit) as Array<{ total_equity: number; total_pnl: number; created_at: string }>;
}

// ── Backtests ──

export function saveBacktest(result: BacktestResult): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO backtests (id, strategy_id, config, result, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(result.id, result.strategy_id, JSON.stringify(result.config), JSON.stringify(result), result.created_at);
}

export function getBacktest(id: string): BacktestResult | null {
  const db = getDb();
  const row = db.prepare("SELECT result FROM backtests WHERE id = ?").get(id) as
    | { result: string }
    | undefined;
  return row ? JSON.parse(row.result) : null;
}
