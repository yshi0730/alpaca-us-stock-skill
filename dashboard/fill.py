"""Fill backfill — polls Alpaca for an order's status, updates the
matching trade_reasoning row, and broadcasts FILL (or ERROR).

Pairs write-contract Rule 3 with its broadcast. Safe to call repeatedly;
idempotent — re-running on an already-filled order is a no-op.

    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/fill.py <client_order_id>

Exit codes:
    0   filled — trade_reasoning backfilled, FILL broadcast written
    1   still working — order is `new`/`accepted`/`partially_filled`/`pending_*`
    2   terminal failure — order `canceled`/`expired`/`rejected`/`done_for_day` etc.
    3   error (creds missing, network, etc.)

Useful from a cron tick: iterate recent pending trade_reasoning rows
and call this for each.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
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


WORKING_STATUSES = {"new", "accepted", "partially_filled", "pending_new",
                    "pending_cancel", "pending_replace", "accepted_for_bidding",
                    "stopped", "calculated"}
TERMINAL_FAIL = {"canceled", "expired", "rejected", "suspended", "done_for_day", "replaced"}


def main() -> int:
    p = argparse.ArgumentParser(description="Backfill a fill (Rule 3 + FILL broadcast).")
    p.add_argument("client_order_id")
    args = p.parse_args()
    cid = args.client_order_id

    key, sec, paper = _read_creds()
    try:
        with AlpacaClient(key, sec, paper=paper) as ac:
            order = ac.get_order(client_order_id=cid)
    except AlpacaError as e:
        print(f"error: lookup failed — {e}", file=sys.stderr)
        return 3

    status = (order.get("status") or "").lower()
    symbol = order.get("symbol", "?")
    qty = order.get("filled_qty") or order.get("qty") or "?"
    fill_price = order.get("filled_avg_price")
    broker_id = order.get("id", "")

    db = sqlite3.connect(str(DB_PATH))
    try:
        # check if already backfilled (idempotent)
        row = db.execute(
            "SELECT executed_at FROM trade_reasoning WHERE client_order_id=? AND agent_id=?",
            (cid, AGENT_ID),
        ).fetchone()
        if row is None:
            print(f"warn: no trade_reasoning row for cid={cid!r} (was it created via dashboard/trade.py?)",
                  file=sys.stderr)
        already_done = bool(row and row[0])

        if status == "filled":
            if already_done:
                print(f"already backfilled · {symbol} {qty} @ {fill_price}")
                return 0
            db.execute(
                "UPDATE trade_reasoning SET broker_order_id=?, executed_at=?, price=? "
                "WHERE client_order_id=? AND agent_id=?",
                (broker_id, order.get("filled_at") or order.get("updated_at"),
                 float(fill_price) if fill_price else None, cid, AGENT_ID),
            )
            db.commit()
            # FILL row — agent rarely calls fill.py interactively (it's a
            # cron/poll helper), so we keep the broadcast structural.
            broadcast_row(
                "FILL",
                f"filled · {symbol} {qty} @ ${fill_price}",
                actor="[Broker]",
                level="done",
            )
            print(f"✓ filled · {symbol} {qty} @ {fill_price}")
            return 0

        if status in WORKING_STATUSES:
            print(f"working · status={status} · {symbol} (filled {order.get('filled_qty','0')}/{order.get('qty','?')})")
            return 1

        if status in TERMINAL_FAIL:
            reason = order.get("reject_reason", "")
            msg = f"{symbol} · order {status}"
            if reason:
                msg += f" · {reason}"
            broadcast_row("ERROR", msg, actor="[Broker]", level="error")
            print(f"failed · status={status} · {symbol}", file=sys.stderr)
            return 2

        print(f"unknown status: {status} — order: {order}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
