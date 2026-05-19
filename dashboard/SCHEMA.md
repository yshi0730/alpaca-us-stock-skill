# US Equity Desk Dashboard — Schema & Data Contract

The fixed per-desk dashboard (`hub-app/templates/us-equity-desk.html`, eventually Jinja) is rendered from two sources:

1. **Alpaca REST API** — live, fetched per request using the user's key. Source of truth for account, positions, fills, NAV history. Never duplicated into shared.db.
2. **`~/.claw/shared/shared.db`** — the *annotation layer* written by the trading agent. Adds the "why" (AI reasoning), strategy attribution, and configured guardrails that Alpaca doesn't know about.

This doc defines the 3 new shared.db tables and **the contract the agent must follow when writing them**. The tables are auto-created by `src/storage/db.py::_init_tables`.

---

## ER (relationships)

```
                 agent_config
                 (agent_id, key) PK
                 category: guardrail|mode|preference
                        │
                        │ scoped by agent_id
                        ▼
   ┌─────────────────────────────────────────┐
   │  agent_id  (e.g. alpaca-us-stock-trader) │
   └─────────────────────────────────────────┘
        │                              │
        │ 1                            │ 1
        ▼ N                            ▼ N
  strategy_state                  trade_reasoning
  id (slug) PK                    id (uuid) PK
  ───────────────  strategy_id    ──────────────────
  name             ◄──────────────  strategy_id (FK, nullable)
  status                            client_order_id ──┐
  authorization_level               broker_order_id ──┤ join keys to
  pnl_cumulative                    action            │ Alpaca
  pnl_today                         symbol/qty/price  │ /v2/account
  positions_count                   reasoning         │ /activities
  last_action(_at)                  realized_pnl      │
                                    decided_at  ──────┘
                                    executed_at
```

- One agent has **N strategies** (`strategy_state`) and **N decisions** (`trade_reasoning`).
- `trade_reasoning.strategy_id` → `strategy_state.id` (nullable: manual/ad-hoc trades have no strategy).
- `trade_reasoning` joins to Alpaca fills via `client_order_id` (preferred, agent-controlled) or `broker_order_id` (fallback, set after order ack).
- HOLD decisions have **no order**: `client_order_id`/`broker_order_id`/`qty`/`executed_at` all NULL — the row exists purely to show "the AI looked and decided not to act".

---

## Table 1 — `strategy_state`

Live per-strategy state. Powers the dashboard's **Active Strategies** panel.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | slug, e.g. `mag7-momentum`, `quality-mr-x7k3` |
| `agent_id` | TEXT | `alpaca-us-stock-trader` |
| `name` | TEXT | display name `Mag7 Momentum Rotation` |
| `template` | TEXT | `mag7-momentum`/`quality-mr`/`vix-spike`/`sector-rotation`/`earnings-drift`/`custom` |
| `status` | TEXT | `running`/`paused`/`paper`/`backtesting`/`stopped` |
| `authorization_level` | INTEGER | 0 advisory · 1 semi-auto · 2 full-auto |
| `params` | TEXT(JSON) | strategy-specific config |
| `pnl_cumulative` | REAL | cached running P&L — agent updates on each trade |
| `pnl_today` | REAL | cached today's P&L — agent resets at session open |
| `positions_count` | INTEGER | open positions tied to this strategy |
| `last_action` | TEXT | human text `减仓 NVDA 50 @ $886.40` |
| `last_action_at` | TEXT | ISO ts |
| `created_at` / `updated_at` | TEXT | `datetime('now')` |

P&L is **cached** (agent-maintained) not computed, so the dashboard read stays a single fast SELECT. The agent's nightly reconcile job can recompute from `trade_reasoning.realized_pnl` to correct drift.

## Table 2 — `trade_reasoning`

One row per AI decision (including HOLDs). Powers the **Execution Feed** + the holdings "策略" column.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | uuid |
| `agent_id` | TEXT | |
| `strategy_id` | TEXT | → `strategy_state.id`, nullable |
| `client_order_id` | TEXT | agent sets this on the Alpaca order; primary join key |
| `broker_order_id` | TEXT | Alpaca order id; backfilled after ack |
| `action` | TEXT | `buy`/`sell`/`add`/`reduce`/`close`/`hold` |
| `symbol` | TEXT | |
| `qty` | REAL | NULL for `hold` |
| `price` | REAL | fill price; ref price for `hold` |
| `reasoning` | TEXT | the AI explanation — **the product differentiator** |
| `realized_pnl` | REAL | set on `close`/`reduce`/`sell` |
| `decided_at` | TEXT | when AI decided (feed ordering key) |
| `executed_at` | TEXT | when filled; NULL for hold/pending |
| `created_at` | TEXT | |

**Holdings "策略" column derivation**: for symbol X, the strategy is the `strategy_id` of the most recent `trade_reasoning` row where `symbol=X AND action IN ('buy','add')` and the position is still open. v1 assumes one symbol → one strategy at a time (true for the template strategies; they don't overlap symbols). If overlap appears later, add a `position_strategy(agent_id, symbol, strategy_id)` table.

## Table 3 — `agent_config`

KV-shaped, scoped by `agent_id`, categorized so the dashboard filters to `category='guardrail'`. Powers the **Guardrails** panel (limits only; the *current* value is computed live by the dashboard from Alpaca and compared against the limit).

| Column | Type | Notes |
|--------|------|-------|
| `agent_id` | TEXT | part of PK |
| `key` | TEXT | part of PK |
| `value` | TEXT | stored as string |
| `value_type` | TEXT | `number`/`bool`/`string`/`json` |
| `category` | TEXT | `guardrail`/`mode`/`preference` |
| `label` | TEXT | display label `单仓上限` |
| `updated_at` | TEXT | |

### Well-known keys

**category = `guardrail`** (rendered in the Guardrails panel):

| key | value_type | default | label |
|-----|-----------|---------|-------|
| `max_position_pct` | number | 10 | 单仓上限 |
| `max_daily_loss_pct` | number | 3 | 日内最大亏损 |
| `max_daily_trades` | number | 10 | 日内最大交易数 |
| `max_order_value` | number | 5000 | 单笔最大金额 |
| `allowed_hours` | string | `market` | 交易时段 |
| `stop_loss_required` | bool | true | 止损必备 |
| `paper_first` | bool | true | 新策略 paper |
| `paper_trial_days` | number | 5 | paper 天数 |
| `circuit_breaker_daily_loss_pct` | number | 3 | 熔断条件 |

**category = `mode`**:

| key | value_type | default |
|-----|-----------|---------|
| `trading_mode` | string | `paper` |
| `default_authorization_level` | number | 1 |

---

## Table 4 — `ai_broadcast`

Append-only feed of "what the AI is doing right now." Drives the
terminal-style **AI Broadcast** panel at the top of the dashboard. The
agent writes one row per meaningful step; the dashboard reads the most
recent N (default 40), reversed so the newest is at the bottom.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINCREMENT | sort key (monotonic, more reliable than `ts`) |
| `agent_id` | TEXT NOT NULL | always `'alpaca-us-stock-trader'` |
| `ts` | TEXT NOT NULL DEFAULT `datetime('now')` | UTC; the renderer keeps only `HH:MM:SS` |
| `tag` | TEXT NOT NULL | `SYSTEM` / `USER` / `AGENT` / `DECIDE` / `ORDER` / `FILL` / `HOLD` / `WARN` / `ERROR` |
| `actor` | TEXT DEFAULT `''` | bracketed label, e.g. `[Screener]`, `[Trader]`, `[Risk]`, `[Broker]`, `[Report]` |
| `msg` | TEXT NOT NULL | short narrative (one line, ≤ ~120 chars renders best) |
| `level` | TEXT NOT NULL DEFAULT `'info'` | `info` / `done` (✓ green prefix) / `warn` (amber) / `error` (red) |

`CREATE TABLE IF NOT EXISTS` is invoked by `dashboard/broadcast.py` on
every write — no separate init step. Table is append-only; pruning is
the dashboard's read-side problem (LIMIT 40), not the agent's.

### How the agent appends a row

Prefer the helper (validates `tag`/`level`, auto-creates the table):

```bash
python3 dashboard/broadcast.py TAG MSG [--actor "[Foo]"] [--level info|done|warn|error]
```

Direct SQL is also fine when you're already in Python:

```python
db.execute("INSERT INTO ai_broadcast(agent_id,tag,actor,msg,level) VALUES(?,?,?,?,?)",
           ("alpaca-us-stock-trader", "AGENT", "[Screener]", "扫描 SP500…", "info"))
```

### Tag taxonomy (the colour bar in the terminal)

| tag | when to use |
|-----|-------------|
| `SYSTEM` | infra events the agent didn't *do* (market open/close, cron tick, hub started, idle) |
| `USER` | user direct message / instruction surfaced into the feed |
| `AGENT` | a step the agent is doing (scan / plan / analyze / draft / refine) |
| `DECIDE` | concrete decision narrative: "buy NVDA 5 because …" |
| `ORDER` | submitted an order (include the `client_order_id`) |
| `FILL` | broker confirmed a fill |
| `HOLD` | analyzed and chose NOT to act, plus the why |
| `WARN` | non-fatal anomaly (vol spike, signal drift, guardrail near-miss) |
| `ERROR` | failed action (order rejected, API down, etc.) — use `--level error` |

---

## Agent write contract (alpaca-us-stock-agent)

When we update the agent's SKILL.md / USER.md, it must do the following. The dashboard assumes these are honored.

**0. Always — broadcast every meaningful step.** Whenever the agent is
*about to do*, *did*, or *decided not to do* something, append one row
to `ai_broadcast` via `python3 dashboard/broadcast.py TAG MSG --actor
"[Foo]"` (see Table 4). This is the highest-frequency write — once per
step (scan, decide, order, fill, HOLD, warn, error). Rules 1–7 below
remain mandatory for the structured panels; broadcast is the *narrative*
on top of them, and it drives the prominent top-of-page terminal panel.

1. **On strategy create / activate / pause / stop**
   `INSERT OR REPLACE` a `strategy_state` row. Keep `status`, `authorization_level`, `params` current.

2. **On order placement**
   - Generate `client_order_id = "{agent_short}-{strategy_id}-{uuid8}"` and pass it to Alpaca's order request.
   - Immediately `INSERT` a `trade_reasoning` row: `client_order_id`, `strategy_id`, `action`, `symbol`, `qty`, intended `price`, `reasoning`, `decided_at=now`. Leave `broker_order_id`/`executed_at`/`realized_pnl` NULL.

3. **On fill confirmation**
   `UPDATE trade_reasoning SET broker_order_id=?, executed_at=?, price=<fill>, realized_pnl=<if closing> WHERE client_order_id=?`.

4. **On HOLD decision** (analysis ran, chose not to trade)
   `INSERT` a `trade_reasoning` row with `action='hold'`, `qty=NULL`, `price=<ref price>`, `reasoning`, `decided_at=now`. No order, no client_order_id.

5. **On P&L change** (fill, mark-to-market refresh, session open)
   `UPDATE strategy_state SET pnl_cumulative=?, pnl_today=?, positions_count=?, last_action=?, last_action_at=?` for the affected strategy.

6. **On guardrail / mode configuration** (during onboarding S5a/S5b or when user changes settings)
   `INSERT OR REPLACE` `agent_config` rows for the well-known keys above with `category='guardrail'` / `'mode'`.

7. **On Alpaca credential setup** (right after the user provides the key)
   `INSERT OR REPLACE` these `agent_config` rows so the dashboard hub-app
   (a separate process that can't see the agent's injected env vars) can
   construct its read-only Alpaca client:

   | key | value_type | category |
   |-----|-----------|----------|
   | `alpaca_key` | string | mode |
   | `alpaca_secret` | string | mode |
   | `alpaca_paper` | bool | mode |

   This is not a *new* plaintext exposure: the alpaca skill already keeps
   the same secret in its own `data/alpaca-skill.db` on the same device.
   shared.db is the same trust boundary. If `alpaca_key` is absent the
   dashboard renders a "not configured" page instead of erroring.

Everything else the dashboard needs (equity, cash, buying power, positions, fills, NAV history, SPY benchmark) comes **straight from Alpaca** and is never written to shared.db.

---

## What the dashboard reads

| Panel | Source |
|-------|--------|
| Top status (NYSE open, account #) | Alpaca `/v2/clock`, `/v2/account` |
| **AI Broadcast** (top terminal panel) | `ai_broadcast` WHERE agent_id, latest 40, oldest-first |
| KPI strip (equity, day P&L, YTD, α, cash, buying power) | Alpaca account + `/v2/account/portfolio/history` |
| NAV vs SPY chart | Alpaca portfolio history + `/v2/stocks/bars` (SPY) |
| Active Strategies | `strategy_state` WHERE agent_id |
| Holdings table | Alpaca `/v2/positions`; 策略 column ← `trade_reasoning` derivation |
| Execution Feed | Alpaca `/v2/account/activities` LEFT JOIN `trade_reasoning` on order id, UNION holds from `trade_reasoning` |
| Risk Cockpit | Alpaca positions + history → computed (VaR/Beta/Sharpe/DD/concentration) |
| Guardrails | `agent_config` WHERE category='guardrail' (limits) + live computed current values |

Pure-computation pieces (Sharpe, Max DD, Beta, VaR, concentration) live in `hub-app/services/portfolio_metrics.py` — no DB, no API, unit-testable with synthetic series. That's the next thing to build.
