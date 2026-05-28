# REFERENCE.md — look-up material

Reference content for the alpaca-us-stock-trader agent. **NOT
auto-loaded** — Read the section you need when you need it. `SKILL.md`
points here for details; `USER.md` state machine references specific
sections (e.g. S5a Authorization Levels).

---

## Authorization Levels

When a user first sets up a strategy, negotiate an **authorization
level**:

| Level | Name | Behavior | Best For |
|---|---|---|---|
| 0 | **Advisory** | Agent suggests, user confirms every trade | Learning / new users |
| 1 | **Semi-Auto** | Agent executes within guardrails, notifies after. Pauses and asks for trades exceeding guardrails. | Most users |
| 2 | **Full Auto** | Agent executes all strategy signals autonomously. User reviews daily/weekly. | Experienced users with tested strategies |

**Default: Level 1 (Semi-Auto)** — what most users actually want.

Ask the user during strategy setup:
> "这个策略你想让我自动执行，还是每次都问你？推荐半自动模式：符合风控规则的交易我直接执行并通知你，超出规则的暂停等你确认。"

---

## Guardrails — defaults + behavior

Every automated strategy **must** have guardrails. Set these with the
user during strategy creation, store in `agent_config` (see SCHEMA.md
Table 3 well-known keys for column shape).

| Guardrail | Default | Description |
|---|---|---|
| `max_position_pct` | 10% | Max % of equity per single position |
| `default_trading_allocation_pct` | 25% | Default paper allocation if user lets agent decide; never use 100% without explicit approval |
| `max_daily_loss_pct` | 3% | Pause all trading if daily loss exceeds this |
| `max_daily_trades` | 10 | Circuit breaker for overtrading |
| `max_order_value` | $5,000 | Orders above this need manual approval (Level 1 only) |
| `allowed_hours` | Market hours | Only trade during regular hours by default |
| `stop_loss_required` | true | Every entry must have a stop loss |
| `paper_first` | true | New strategies must run on paper for N days before going live |
| `paper_trial_days` | 5 | Minimum paper trading period |
| `circuit_breaker_daily_loss_pct` | 3 | Hard halt threshold (same as max_daily_loss_pct by default) |

**If any guardrail is breached, the agent pauses and notifies the user
— even in Full Auto mode.** Daily loss breach = halt ALL automated
trading + notify immediately (kill switch).

---

## Safety Rules

1. **Manual trades (no strategy)**: Always confirm with user before executing.
2. **Automated trades (strategy active)**: Execute per authorization level, always respect guardrails.
3. **ALWAYS show the trading mode** (PAPER vs LIVE) in order-related responses.
4. **First-time live activation**: Double-confirm with user that real money is at risk.
5. **Large orders (>10% of equity)**: Extra warning, even in auto mode pause and ask.
6. **Never provide guaranteed returns** — always caveat with risk language.
7. **Stop-loss is mandatory** for every automated entry — no exceptions.
8. **Daily loss circuit breaker**: if daily loss exceeds limit, halt ALL automated trading and notify user immediately.
9. **Paper first**: new strategies must paper-trade successfully before going live — enforce this, don't skip.
10. **Never execute "close all" / "cancel all"** without strong explicit user confirmation.

---

## Gateway Pairing and Cron Wakeups

This agent must pair with the OpenClaw Gateway before claiming
autonomous monitoring is active. OpenClaw cron is a Gateway scheduler
created with `openclaw cron add`; it wakes the agent with a message.
The cron message should instruct the agent to call the MCP tool
`alpaca_cron_tick`.

Cron reports must default to WebChat delivery. When setting up Gateway
cron, use explicit delivery: `--announce --channel webchat --to webchat`.
Do not leave the channel blank, do not rely on implicit `channel:last`,
and do not use `--no-deliver` for default reporting. Archive a backup
copy to workspace/dashboard, but the proactive message should go to
WebChat.

Required setup tool:

```json
{
  "tool": "alpaca_setup_gateway_cron",
  "arguments": {
    "risk_check_interval_minutes": 1,
    "timezone": "America/New_York",
    "channel": "webchat",
    "to": "webchat"
  }
}
```

Required cron wakeup message template:

```text
Run alpaca_cron_tick with mode='<morning|pulse|eod|risk_check>'.
Follow the matching ritual in SKILL.md → "Cron Rituals". Deliver the
concise report to WebChat and archive a backup to workspace/dashboard.
```

The exact rituals (Morning / Pulse / EOD / Risk) live in SKILL.md →
"Cron Rituals". manifest.json's `recommendedSchedules` enumerates the
4 modes + their cron expressions.

If Gateway pairing is missing or cron setup fails with "pairing
required", tell the user automation is not fully active and run/follow
the remediation from `alpaca_setup_gateway_cron`. If cron setup or
execution complains about missing channel/conversation/target, retry
with explicit `channel="webchat"` and `to="webchat"` before telling
the user anything.

Do not rely only on chat-session memory for scheduled reminders. Cron
wakeups must be registered in the OpenClaw Gateway, and the wakeup
message must use `alpaca_cron_tick` as the stable tool target.

---

## Precision Rules for Stocks and Crypto

Trading outputs and calculations must preserve high precision:
- Quantities: keep up to 9 decimal places for fractional shares and crypto units.
- Prices and money: keep up to 8 decimal places when the value is below $1 or when crypto precision matters; otherwise show at least cents.
- Percentages: keep up to 4 decimal places for risk checks and P&L.
- Never round a crypto quantity to whole units. Never use whole-share rounding unless the user explicitly requests whole shares or the venue requires it.
- Prefer notional orders for small fractional purchases, and validate the exact quantity/notional before sending an order.

---

## Daily Autonomous Summary template

When running automated strategies, send a daily summary (even if the
user doesn't open chat). Keep it short, beginner-readable, and cover:

- **Executed trades today**: time · action · symbol · qty · price ·
  strategy · status (one line each)
- **Guardrail status**: daily loss vs limit, trade count vs limit,
  largest position vs limit (✅/⚠ each)
- **Portfolio after today**: equity (+/−%), open positions, active
  strategies
- **Next scheduled action** + whether any manual action is needed

Real numbers from the live account — never placeholder data.

---

## MCP Tool Usage Guidelines

The `alpaca-us-stock` MCP skill registers ~38 tools. Most fall into
one of six buckets below. **The single hard rule that matters most**:

> ⛔ **All writes go through `dashboard/*.py` helpers — never through
> MCP write tools.** The dashboard helpers
> (`strategy.py` / `trade.py` / `cancel.py` / `fill.py` / `hold.py`)
> pair every Alpaca-side write with the `trade_reasoning` /
> `strategy_state` row and the matching `ai_broadcast` row that the
> dashboard panels render from. The MCP write tools — `alpaca_place_
> order`, `alpaca_cancel_order`, `alpaca_close_position`,
> `alpaca_create_strategy`, etc. — write to Alpaca / the TS-side
> storage **but skip the write contract entirely**. If you use them
> the dashboard goes inconsistent (an order shows "pending" forever,
> a strategy is missing from Active Strategies, no broadcast).

### Bucket 1 — Reads (use freely)

These don't conflict with anything; helpful for ad-hoc queries:

- `alpaca_get_account` — equity / cash / buying power
- `alpaca_get_positions` — current positions
- `alpaca_get_orders` — recent orders + status
- `alpaca_get_performance` — performance metrics
- `alpaca_get_trade_journal` — past trades + reasoning history
- `alpaca_get_strategy` / `alpaca_list_strategies` / `alpaca_list_strategy_templates` — strategy CRUD reads

### Bucket 2 — Market data (use freely)

- `alpaca_get_quote` — single stock deep-dive
- `alpaca_get_snapshot` — multi-symbol at-a-glance
- `alpaca_get_bars` — chart analysis. **Paper-account caveat:** without an explicit `start`, IEX silently returns ≤1 bar. Always pass `start`.
- `alpaca_market_overview` — session-opening context
- `alpaca_screen_stocks` — opportunity discovery

### Bucket 3 — Writes (⛔ DO NOT call these directly — use helpers)

| Want to | Use this helper instead | NOT this MCP tool |
|---|---|---|
| Place an order | `dashboard/trade.py` | ~~`alpaca_place_order`~~ |
| Cancel a working order | `dashboard/cancel.py` | ~~`alpaca_cancel_order`~~ |
| HOLD decision | `dashboard/hold.py` | (no MCP equivalent — good) |
| Backfill a fill | `dashboard/fill.py` | (poll loop, no MCP equiv) |
| Activate / pause / stop a strategy | `dashboard/strategy.py` | ~~`alpaca_create_strategy`~~, ~~`alpaca_delete_strategy`~~ |
| Close a position | `dashboard/trade.py <SYM> <QTY> sell --action close` | ~~`alpaca_close_position`~~ |

### Bucket 4 — Cron + monitoring (use cron, NOT local monitor)

We schedule everything through Gateway cron — see "Gateway Pairing and
Cron Wakeups" above. **Do NOT also start the TS-side local monitor**;
two monitors = double notifications / wasted polling:

- `alpaca_cron_tick` — the cron entry point. Wakeups dispatch by `mode`.
- `alpaca_setup_gateway_cron` — sets up the Gateway-side cron job.
- ⛔ `alpaca_start_monitor` / `alpaca_stop_monitor` — local poll process. **Don't use.** Gateway cron replaces this.
- ⛔ `alpaca_add_alert` / `alpaca_remove_alert` / `alpaca_get_alerts` — local alert system. **Don't use.** Equivalent flows already exist via `risk_check` cron + WARN broadcasts.

### Bucket 5 — Backtest (use before activating new strategies)

- `alpaca_backtest` — run a strategy against historical data. Minimum 6 months for meaningful results. Always compare against buy-and-hold SPY.
- `alpaca_get_backtest_results` — fetch results of an earlier backtest run.
- Warn about overfitting when strategies are too complex.

### Bucket 6 — Review / Journal

- `alpaca_review_session` — generate raw session data; **interpret it for the user, don't dump it**.
- `alpaca_add_trade_note` — attach a note to a past trade. Useful for retrospectives ("this was a revenge trade").
- Focus on risk-adjusted returns + behavioral patterns (revenge trading, overconcentration), not raw P&L.

### What's missing from above

A handful of tools aren't decisions for the agent — they're internal:
`alpaca_api_key` / `alpaca_api_secret` / `alpaca_mode` / `alpaca_verified` / `alpaca_configure` / `alpaca_setup_guide`. These are config-storage / one-time setup; `setup.sh creds` handles the equivalent.

---

## Recurring Strategies (DCA, Rebalance)

Time-based (not signal-based) strategies should run via Gateway cron:
- **DCA**: "Every Monday at market open, buy $500 of SPY"
- **Rebalance**: "Monthly, rebalance to 60/40 stocks/bonds"
- **Income harvesting**: "Sell covered calls on held positions when IV > 30th percentile"

These run without user interaction once approved. The agent logs every
execution and includes it in the daily/weekly summary. For each
execution, follow the write contract (rule 2: `trade.py`).

---

## Financial Concepts Glossary

Key concepts to explain clearly when users encounter them:

- **Stop Loss** — A preset maximum loss level that triggers an automatic sell.
- **Take Profit** — A preset profit target that triggers an automatic sell.
- **Sharpe Ratio** — Risk-adjusted return measure; >1 is good, >2 is excellent.
- **Max Drawdown** — Largest peak-to-trough decline, measures worst-case scenario.
- **Win Rate** — Percentage of profitable trades out of total trades.
- **Profit Factor** — Gross profit / gross loss; >1.5 is healthy.
- **Day Trading** — Buying and selling within the same day; beware of PDT rule (3+ day trades in 5 days requires $25K account).
- **Position Sizing** — Single stock should not exceed 10–15% of total capital.
- **Dollar Cost Averaging (DCA)** — Investing fixed amounts at regular intervals to reduce timing risk.
- **PEAD (Post-Earnings Announcement Drift)** — Tendency of stock price to continue drifting in the direction of an earnings surprise; basis of the `earnings-drift` strategy.
- **Mean Reversion** — Statistical tendency of prices/indicators to revert to their average; basis of `quality-mr`.
