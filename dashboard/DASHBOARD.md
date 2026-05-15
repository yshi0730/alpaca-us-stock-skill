# Dashboard — how this agent publishes its US Equity desk

This agent has a polished, fixed dashboard page. It is **not** built from
generic widgets and it does **not** run its own web server or tunnel.

## The two layers (read this first)

```
Layer 0 · claw-dashboard-skill  (generic, shared, you do NOT modify it)
  Provides the device's ONE hub server + ONE cloudflare tunnel
  → device-<serial>.clawln.app  and serves ~/.claw/hub/public/ at /static/
        ▲ the stock page is a sub-page ON TOP of this — never its own server
Layer 1 · dashboard/  (this directory — the stock page + data layer)
  render.py reads live Alpaca + shared.db, fills the template, and writes
  ~/.claw/hub/public/us-equity.html  → device-<serial>.clawln.app/static/us-equity.html
```

A device has exactly one tunnel and one hub. Multiple agents' dashboards
are different **paths** on that one hub, never competing servers. That is
why this skill only writes a file into the hub's public dir.

## Python prerequisites

`render.py` needs **only two** third-party packages — `httpx` and
`jinja2` (see `requirements.txt`). `portfolio_metrics.py` is pure
stdlib by design (no numpy). These are the **same two** packages the
generic claw-dashboard-skill hub-app already declares, so on a device
where Layer 0 is set up they are already installed: run `render.py`
with the same Python interpreter that runs the hub. If unsure:

```bash
python3 -m pip install -r dashboard/requirements.txt
```

(The agent skill itself is Node; only this `dashboard/` subtree is
Python. `manifest.json` does not yet declare a Python bin/dep — the
Python env is inherited from Layer 0.)

## Setup (once, during onboarding)

1. **Ensure Layer 0 is up.** Follow `claw-dashboard-skill`'s
   `DASHBOARD-SETUP-GUIDE.md`: clone it, copy hub-app to `~/.claw/hub/`,
   init `~/.claw/shared/shared.db`, register the device tunnel, start the
   hub + cloudflared. If the user already has any dashboard on this
   device, Layer 0 is already up — do not set it up again.

2. **Mirror Alpaca creds into shared.db.** Right after the user gives you
   their Alpaca key, write it into `agent_config` so `render.py` (a
   separate process) can read it. See `SCHEMA.md` → contract rule 7.

3. **Run the renderer:**
   ```bash
   python3 dashboard/render.py
   ```
   It writes `~/.claw/hub/public/us-equity.html`. Tell the user the URL:
   `https://device-<serial>.clawln.app/static/us-equity.html`

## When to run render.py

- **Every session start** (so the user always sees fresh numbers when
  they open the page).
- **On a cron during market hours** (e.g. every 15 min, 09:30–16:00 ET)
  so the page stays current even when the user isn't chatting. Use the
  same cron mechanism the skill uses for overnight research.
- **After any trade / strategy change** (so the execution feed and
  strategy panel reflect what just happened).

`render.py` never raises: missing creds / Alpaca down / render error all
write a calm status page and exit 0. It will never break your session.

## Keeping the dashboard truthful (the write contract)

The page's Active Strategies / Execution Feed / Guardrails panels are
**empty** unless you write the annotation layer. Every strategy change,
every order, every HOLD decision must be recorded in shared.db per the
6+1 rules in `SCHEMA.md` → "Agent write contract". That is what turns a
generic account view into "an AI that explains every decision".

In short:
- create/activate/pause a strategy → upsert `strategy_state`
- place an order → set a `client_order_id` + write a `trade_reasoning`
  row (reasoning + decided_at)
- fill confirmed → backfill `broker_order_id`/`executed_at`/`realized_pnl`
- decide to HOLD → write a reasoning-only `trade_reasoning` row
- P&L changes → update the cached fields on `strategy_state`
- configure guardrails / Alpaca creds → upsert `agent_config`

See `SCHEMA.md` for exact columns and SQL.

## Env overrides (testing only)

| var | default |
|-----|---------|
| `CLAW_SHARED_DB` | `~/.claw/shared/shared.db` |
| `CLAW_HUB_PUBLIC` | `~/.claw/hub/public` |

## Files

| file | role |
|------|------|
| `render.py` | entry point — reads data, writes the static page |
| `us_equity_context.py` | assembles the template context (formatting, derivations) |
| `alpaca_client.py` | read-only Alpaca REST wrapper |
| `portfolio_metrics.py` | pure-stdlib Sharpe / beta / VaR / drawdown / etc. |
| `templates/us-equity-desk.html` | the Jinja page |
| `SCHEMA.md` | shared.db tables + the agent write contract |
| `tests/` | smoke tests (`_smoke_metrics.py` pure; `_smoke_e2e.py` needs a paper key) |
