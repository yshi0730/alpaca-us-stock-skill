"""Append one row to the dashboard AI Broadcast feed.

The agent calls this every time it starts or finishes a meaningful
step (scan, decide, order, fill, HOLD, warn, error). The dashboard's
top terminal panel re-renders from this table on the next render tick.

Usage:
    python3 dashboard/broadcast.py TAG  MSG  [--actor "[Foo]"] [--level info|done|warn|error]

Examples:
    python3 dashboard/broadcast.py AGENT  "扫描 SP500 候选 (487 支)…"   --actor "[Screener]"
    python3 dashboard/broadcast.py AGENT  "选出 12 支符合条件"          --actor "[Screener]"  --level done
    python3 dashboard/broadcast.py DECIDE "买入 NVDA × 5 @ market"     --actor "[Trader]"
    python3 dashboard/broadcast.py ORDER  "submitted mom-20260519-001" --actor "[Trader]"
    python3 dashboard/broadcast.py FILL   "NVDA × 5 @ \\$892.40"        --actor "[Broker]"   --level done
    python3 dashboard/broadcast.py HOLD   "AAPL · 信号未变,继续持有"     --actor "[Trader]"
    python3 dashboard/broadcast.py WARN   "TSLA σ +2.4σ → 收紧止损"    --actor "[Risk]"     --level warn
    python3 dashboard/broadcast.py ERROR  "下单被拒:risk_premium 超限" --actor "[Broker]"   --level error

TAG taxonomy (case-insensitive on input, stored uppercase):
    SYSTEM   — infra events the agent did NOT do (market open/close, latency, cron tick)
    USER     — user direct message / instruction
    AGENT    — agent is doing something (scan, plan, analyze)
    DECIDE   — concrete decision narrative ("buy NVDA 5 because …")
    ORDER    — submitted an order
    FILL     — order filled (broker confirmed)
    HOLD     — decided NOT to act and why
    WARN     — non-fatal anomaly (vol spike, signal drift, guardrail near-miss)
    ERROR    — failed action (order rejected, API down, etc.)

LEVEL controls the row colour: info (default neutral) / done (✓ green prefix) /
warn (amber text) / error (red text).

The table is created on demand — no separate init needed. Safe to call
millions of times; rows are append-only.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

AGENT_ID = "alpaca-us-stock-trader"
DB_PATH = Path(os.environ.get(
    "CLAW_SHARED_DB",
    str(Path.home() / ".claw" / "shared" / "shared.db"),
))

VALID_TAGS = {"SYSTEM", "USER", "AGENT", "DECIDE", "ORDER", "FILL",
              "HOLD", "WARN", "ERROR"}
VALID_LEVELS = {"info", "done", "warn", "error"}

INIT_SQL = """
CREATE TABLE IF NOT EXISTS ai_broadcast (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  tag TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  msg TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_ai_broadcast_agent_id_desc
  ON ai_broadcast(agent_id, id DESC);
"""


def write_row(tag: str, msg: str, actor: str = "", level: str = "info") -> int:
    tag = tag.upper().strip()
    level = level.lower().strip()
    if tag not in VALID_TAGS:
        print(f"error: tag must be one of {sorted(VALID_TAGS)}", file=sys.stderr)
        return 2
    if level not in VALID_LEVELS:
        print(f"error: level must be one of {sorted(VALID_LEVELS)}", file=sys.stderr)
        return 2
    if not msg.strip():
        print("error: msg cannot be empty", file=sys.stderr)
        return 2

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    try:
        db.executescript(INIT_SQL)
        db.execute(
            "INSERT INTO ai_broadcast(agent_id, tag, actor, msg, level) "
            "VALUES(?,?,?,?,?)",
            (AGENT_ID, tag, actor, msg, level),
        )
        db.commit()
    finally:
        db.close()
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description="Append a row to the dashboard AI Broadcast feed.",
    )
    p.add_argument("tag", help=f"one of {sorted(VALID_TAGS)}")
    p.add_argument("msg", help="short narrative — what the agent is doing right now")
    p.add_argument("--actor", default="",
                   help='bracketed actor label, e.g. "[Screener]" (optional)')
    p.add_argument("--level", default="info",
                   help=f"one of {sorted(VALID_LEVELS)} (default: info)")
    args = p.parse_args()
    return write_row(args.tag, args.msg, args.actor, args.level)


if __name__ == "__main__":
    raise SystemExit(main())
