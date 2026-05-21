"""Order helper — bundles client_order_id + trade_reasoning INSERT +
place_order + DECIDE/ORDER broadcasts into one call.

Use this, NOT direct SQL + raw httpx. Pairs write-contract Rule 2 with
its narrative. Fill backfill (Rule 3) is a separate helper —
`python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/fill.py <client_order_id>`.

    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/trade.py <SYMBOL> <QTY> <buy|sell> \\
        --strategy <strategy_id> --reason "..." \\
        [--type market|limit|stop|stop_limit]   (default: market) \\
        [--limit-price 612.50] [--stop-price 580.00] \\
        [--time-in-force day|gtc|ioc|fok|opg|cls]   (default: day) \\
        [--extended-hours] \\
        [--action buy|sell|add|reduce|close]    (default: side; overrides for clearer feed labelling)

Examples:
    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/trade.py NVDA 5 buy --strategy mag7-momentum \\
        --reason "50DMA 上穿 200DMA · 量能放大 1.8x · 动量入场"
    python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/trade.py META 3 sell --strategy mag7-momentum \\
        --type limit --limit-price 612.50 --action reduce \\
        --reason "触发利润止盈线 +18%,锁定收益"

On success prints `cid=<client_order_id> broker=<broker_order_id>` and
exits 0. On Alpaca rejection: the trade_reasoning row is kept (decision
was made and reasoned), broker_order_id stays NULL, an ERROR broadcast
records the failure, and we exit nonzero so callers can react.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import uuid
from pathlib import Path

# allow direct sibling import for alpaca_client / broadcast
sys.path.insert(0, str(Path(__file__).parent))

from alpaca_client import AlpacaClient, AlpacaError  # noqa: E402
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
CREATE INDEX IF NOT EXISTS idx_trade_reasoning_agent_decided
  ON trade_reasoning(agent_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_reasoning_cid
  ON trade_reasoning(client_order_id);
"""


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
    key, sec = kv.get("alpaca_key"), kv.get("alpaca_secret")
    if not key or not sec:
        print(
            "error: Alpaca creds missing — run "
            "`bash /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/setup.sh creds <KEY> <SECRET> paper` first",
            file=sys.stderr,
        )
        sys.exit(2)
    paper = (kv.get("alpaca_paper", "true").lower() == "true")
    return key, sec, paper


def main() -> int:
    p = argparse.ArgumentParser(
        description="Submit an order with the full write-contract ritual (Rule 2 + broadcasts)."
    )
    p.add_argument("symbol")
    p.add_argument("qty", type=float)
    p.add_argument("side", choices=["buy", "sell"])
    p.add_argument("--strategy", required=True,
                   help="strategy_id (slug); use 'manual' for ad-hoc trades")
    p.add_argument("--reason", required=True,
                   help="WHY (the agent's narrative — the product differentiator)")
    p.add_argument("--type", dest="type_", default="market",
                   choices=["market", "limit", "stop", "stop_limit"])
    p.add_argument("--limit-price", type=float, default=None)
    p.add_argument("--stop-price", type=float, default=None)
    p.add_argument("--time-in-force", default="day",
                   choices=["day", "gtc", "ioc", "fok", "opg", "cls"])
    p.add_argument("--extended-hours", action="store_true")
    p.add_argument("--action", default=None,
                   choices=["buy", "sell", "add", "reduce", "close"],
                   help="overrides feed action label (e.g. 'reduce' instead of 'sell')")
    p.add_argument("--broadcast", default=None,
                   help="DECIDE row prose in the user's language (read "
                        "agent_config.user_locale). Falls back to neutral "
                        "structural form '<sym> · <action> <qty> · <reason>'. "
                        "ORDER + ERROR rows are always neutral structural.")
    args = p.parse_args()

    action = args.action or args.side
    symbol = args.symbol.upper()
    cid = f"alpaca-{args.strategy}-{uuid.uuid4().hex[:8]}"
    reasoning_id = uuid.uuid4().hex

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    db.executescript(INIT_SQL)

    # 1. trade_reasoning row FIRST — WHY before the order
    db.execute(
        "INSERT INTO trade_reasoning"
        "(id, agent_id, strategy_id, client_order_id, action, symbol, qty, price, reasoning) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            reasoning_id, AGENT_ID, args.strategy, cid,
            action, symbol, args.qty, args.limit_price, args.reason,
        ),
    )
    db.commit()

    # 2. DECIDE broadcast — agent supplies the prose via --broadcast (in the
    # user's language); fall back to a neutral structural form so the row is
    # never empty even if the agent forgot.
    decide_msg = args.broadcast or f"{symbol} · {action} {args.qty:g} · {args.reason}"
    broadcast_row("DECIDE", decide_msg, actor=f"[{args.strategy}]")

    # 3. place_order via AlpacaClient (canonical write path)
    key, sec, paper = _read_creds()
    try:
        with AlpacaClient(key, sec, paper=paper) as ac:
            r = ac.place_order(
                symbol=symbol,
                qty=args.qty,
                side=args.side,
                type_=args.type_,
                time_in_force=args.time_in_force,
                limit_price=args.limit_price,
                stop_price=args.stop_price,
                client_order_id=cid,
                extended_hours=args.extended_hours,
            )
    except AlpacaError as e:
        # ERROR row is always structural / language-neutral.
        broadcast_row(
            "ERROR",
            f"{symbol} · order rejected · Alpaca HTTP {e.status}",
            actor="[Broker]",
            level="error",
        )
        db.close()
        print(f"error: order rejected — {e}", file=sys.stderr)
        return 3

    broker_id = r.get("id", "")
    # 4. backfill broker_order_id
    db.execute(
        "UPDATE trade_reasoning SET broker_order_id=? WHERE client_order_id=?",
        (broker_id, cid),
    )
    db.commit(); db.close()

    # 5. ORDER broadcast — structural confirmation (always language-neutral).
    # The narrative WHY already went out in DECIDE; this is the technical
    # "order is in flight" beat.
    if args.limit_price is not None:
        px_phrase = f"limit {args.limit_price:g}"
    elif args.type_ == "market":
        px_phrase = "market"
    else:
        px_phrase = args.type_
    broadcast_row(
        "ORDER",
        f"order submitted · {symbol} {action} {args.qty:g} · {px_phrase}",
        actor="[Trader]",
    )

    print(f"cid={cid} broker={broker_id}")
    print(f"next: when filled, run `python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/fill.py {cid}` (rule 3 + FILL broadcast)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
