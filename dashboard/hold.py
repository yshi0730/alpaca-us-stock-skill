"""HOLD decision helper — pairs a reasoning-only trade_reasoning row
with a HOLD broadcast in one call.

This is the SECRET to the product feeling like "an AI that thinks":
HOLDs prove the agent considered acting and chose not to. Without a
HOLD record the dashboard looks idle even when the agent has been
working hard. Pairs write-contract Rule 4 with its broadcast.

    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/hold.py <SYMBOL> --strategy <strategy_id> \\
        --reason "..." [--ref-price 191.05]

Examples:
    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/hold.py AAPL --strategy mag7-momentum \\
        --reason "动量得分 0.62 略低于 0.7 入场阈值,继续持有"
    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/hold.py TSLA --strategy mag7-momentum --ref-price 228.40 \\
        --reason "波动率 2.4σ 触发,等回到 <2σ 再考虑加仓"
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from broadcast import write_row as broadcast_row  # noqa: E402

AGENT_ID = "alpaca-us-stock-trader"
DB_PATH = Path(os.environ.get(
    "CLAW_SHARED_DB",
    str(Path.home() / ".claw" / "shared" / "shared.db"),
))

INIT_SQL = """
CREATE TABLE IF NOT EXISTS trade_reasoning (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  strategy_id TEXT,
  client_order_id TEXT,
  broker_order_id TEXT,
  action TEXT NOT NULL,
  symbol TEXT NOT NULL,
  qty REAL,
  price REAL,
  reasoning TEXT NOT NULL,
  realized_pnl REAL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
"""


def main() -> int:
    p = argparse.ArgumentParser(
        description="Record a HOLD decision (Rule 4 + HOLD broadcast)."
    )
    p.add_argument("symbol")
    p.add_argument("--strategy", required=True,
                   help="strategy_id (slug); use 'manual' for ad-hoc holds")
    p.add_argument("--reason", required=True,
                   help="WHY you chose not to act (the agent's narrative)")
    p.add_argument("--ref-price", type=float, default=None,
                   help="optional reference price at decision time")
    p.add_argument("--broadcast", default=None,
                   help="HOLD row prose in user's language; falls back to "
                        "'<sym> · HOLD · <reason>'.")
    args = p.parse_args()

    symbol = args.symbol.upper()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    db.executescript(INIT_SQL)
    db.execute(
        "INSERT INTO trade_reasoning"
        "(id, agent_id, strategy_id, action, symbol, qty, price, reasoning) "
        "VALUES (?, ?, ?, 'hold', ?, NULL, ?, ?)",
        (uuid.uuid4().hex, AGENT_ID, args.strategy, symbol, args.ref_price, args.reason),
    )
    db.commit(); db.close()

    msg = args.broadcast or f"{symbol} · HOLD · {args.reason}"
    broadcast_row("HOLD", msg, actor=f"[{args.strategy}]")

    print(f"✓ HOLD recorded for {symbol} (strategy={args.strategy})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
