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

**category = `preference`**:

| key | value_type | default | notes |
|-----|-----------|---------|-------|
| `user_locale` | string | `zh-CN` | BCP-47-like (`zh-CN` / `en` / etc.). **Agent writes this at S1** (the language of the verbatim intro it emitted). **Agent reads it at the start of every session, including every cron tick**, and writes all broadcasts / user-facing replies in that language. Helpers do NOT read this (they're locale-neutral) — the agent supplies `--broadcast "<text in that language>"` when calling a helper. |

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
python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/broadcast.py TAG MSG [--actor "[Foo]"] [--level info|done|warn|error]
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

The agent must honor these. **Use the helpers** — they bundle each
structured table-write with its matching broadcast so neither half is
ever forgotten.

**0. Broadcast = your live voice.** The dashboard's AI Broadcast panel
shows the user you working in real time. **Default to speaking, not
silence.** Broadcast-worthy:
- Every **external I/O** — API call, web search, market-data fetch.
- Every **decision** — buy / sell / HOLD / wait / escalate.
- Every **signal / anomaly / state change**.
- Every **research step** — scanning news, checking sentiment, reading filings.

Not broadcast-worthy: internal string formatting, JSON parsing,
re-reading your own docs.

Two paths to write:
- **Structured events (rules 1–4 below): use the helpers.** They write
  the DB row AND broadcast in one call — you cannot forget either.
- **Open-ended events (research, analysis, alerts, idle):** use
  `python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/broadcast.py TAG "msg" --actor "[Foo]" [--level …]`
  directly. The agent narrates freely.

When in doubt, broadcast. Silence makes the agent look dead.

1. **On strategy create / activate / pause / resume / stop** →
   ```
   python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/strategy.py activate <id> --name "..." --template "..." \
       --reason "..." [--params '<json>'] [--authorization-level 1]
   python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/strategy.py pause|resume|stop <id> --reason "..."
   ```
   Writes `strategy_state` AND broadcasts AGENT/WARN. **Do NOT** write
   `strategy_state` by hand SQL — it skips the broadcast and the
   dashboard's narrative goes silent.

2. **On order placement** →
   ```
   python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/trade.py <SYMBOL> <QTY> <buy|sell> \
       --strategy <id> --reason "..." \
       [--type market|limit|stop|stop_limit] [--limit-price N] [...]
   ```
   Bundles `client_order_id` generation + `trade_reasoning` INSERT
   (WHY) + `AlpacaClient.place_order` + DECIDE/ORDER broadcasts.
   Prints `cid=…` for step 3. **Do NOT** `httpx.post /v2/orders` by
   hand — this helper is the canonical write path.

3. **On fill** →
   ```
   python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/fill.py <client_order_id>
   ```
   Polls Alpaca; on `filled` updates `trade_reasoning` (executed_at,
   price) + writes FILL broadcast. Safe to call from cron — idempotent.
   Exit codes: 0 filled / 1 working / 2 failed / 3 error.

4. **On HOLD decision** →
   ```
   python3 /home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard/hold.py <SYMBOL> --strategy <id> --reason "..." [--ref-price N]
   ```
   Writes the reasoning-only `trade_reasoning` row AND broadcasts HOLD.
   These prove the agent is thinking even when not trading — write
   liberally.

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
