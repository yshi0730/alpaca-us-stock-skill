"""Cancel a working order — completes the write contract for orders.

Pairs the Alpaca cancel with a follow-up `trade_reasoning` row + a
broadcast, so the dashboard's Active Strategies / Execution Feed /
AI Broadcast panels stay consistent. Use this — NOT the MCP
`alpaca_cancel_order` tool — when killing a working order, otherwise
the order will appear "pending" forever on the dashboard.

    python3 dashboard/cancel.py <CLIENT_ORDER_ID> --reason "..." \\
        [--broadcast "..."]

Example:
    python3 dashboard/cancel.py alpaca-mag7-momentum-a4f01102 \\
        --reason "信号弱化,撤回" \\
        --broadcast "撤了刚才那张 NVDA 单 —— 量能没起来,等下根"

Exit codes:
    0   canceled — DB row added, ORDER broadcast written
    2   no trade_reasoning row found for cid (was the order placed via trade.py?)
    3   Alpaca rejected the cancel (already filled / unknown order)
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from alpaca_client import AlpacaClient, AlpacaError  # noqa: E402
from broadcast import write_row as broadcast_row  # noqa: E402

AGENT_ID = "alpaca-us-stock-trader"
DB_PATH = Path(os.environ.get(
    "CLAW_SHARED_DB",
    str(Path.home() / ".claw" / "shared" / "shared.db"),
))


def _read_creds() -> tuple[str, str, bool]:
    db = sqlite3.connect(str(DB_PATH))
    try:
        rows = db.execute(
            "SELECT key, value FROM agent_config WHERE agent_id=? "
            "AND key IN ('alpaca_key','alpaca_secret','alpaca_paper')",
            (AGENT_ID,),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    finally:
        db.close()
    kv = {k: v for k, v in rows}
    if not kv.get("alpaca_key") or not kv.get("alpaca_secret"):
        print("error: Alpaca creds missing in agent_config", file=sys.stderr)
        sys.exit(3)
    return kv["alpaca_key"], kv["alpaca_secret"], (kv.get("alpaca_paper", "true").lower() == "true")


def main() -> int:
    p = argparse.ArgumentParser(
        description="Cancel a working order (write-contract preserving).",
    )
    p.add_argument("client_order_id")
    p.add_argument("--reason", required=True,
                   help="WHY you're canceling (the agent's narrative)")
    p.add_argument("--broadcast", default=None,
                   help="ORDER row prose in user's language; "
                        "falls back to '<sym> · canceled · <reason>'.")
    args = p.parse_args()
    cid = args.client_order_id

    # 1. Look up the original trade_reasoning row to recover strategy_id
    #    / symbol / broker_order_id / qty for the follow-up rows.
    db = sqlite3.connect(str(DB_PATH))
    row = db.execute(
        "SELECT strategy_id, symbol, broker_order_id, qty "
        "FROM trade_reasoning WHERE client_order_id=? AND agent_id=?",
        (cid, AGENT_ID),
    ).fetchone()
    if row is None:
        print(f"error: no trade_reasoning row for cid={cid!r} "
              f"(was the order placed via dashboard/trade.py?)",
              file=sys.stderr)
        db.close()
        return 2
    strategy_id, symbol, broker_id, qty = row
    db.close()

    # 2. Cancel via Alpaca. cancel_order() needs the broker id, not cid.
    if not broker_id:
        print(f"warn: cid={cid!r} has no broker_order_id yet "
              f"(order may still be in flight); cannot cancel",
              file=sys.stderr)
        return 2
    key, sec, paper = _read_creds()
    try:
        with AlpacaClient(key, sec, paper=paper) as ac:
            ac.cancel_order(broker_id)
    except AlpacaError as e:
        # broadcast the failure so the dashboard reflects reality
        broadcast_row(
            "ERROR",
            f"{symbol} · cancel rejected · Alpaca HTTP {e.status}",
            actor="[Broker]",
            level="error",
        )
        print(f"error: cancel rejected — {e}", file=sys.stderr)
        return 3

    # 3. Write a follow-up trade_reasoning row capturing the decision.
    #    action='cancel' is a new value; SCHEMA.md notes this in the
    #    trade_reasoning action enum.
    cancel_id = uuid.uuid4().hex
    db = sqlite3.connect(str(DB_PATH))
    db.execute(
        "INSERT INTO trade_reasoning"
        "(id, agent_id, strategy_id, client_order_id, broker_order_id, "
        " action, symbol, qty, reasoning) "
        "VALUES (?, ?, ?, ?, ?, 'cancel', ?, ?, ?)",
        (cancel_id, AGENT_ID, strategy_id, cid, broker_id,
         symbol, qty, args.reason),
    )
    db.commit(); db.close()

    # 4. ORDER broadcast — agent supplies the prose; fall back to
    #    neutral structural form.
    msg = args.broadcast or f"{symbol} · canceled · {args.reason}"
    broadcast_row(
        "ORDER",
        msg,
        actor=f"[{strategy_id}]" if strategy_id else "[Trader]",
    )

    print(f"✓ canceled · {symbol} cid={cid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
