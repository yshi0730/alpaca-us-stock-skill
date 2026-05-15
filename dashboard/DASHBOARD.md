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

## Setup — two commands, that's it

The fragile 12-step infra sequence is proceduralized in `setup.sh`
(idempotent — safe to re-run every session). The agent never hand-runs
clone / pip / mkdir / tunnel-register / nohup.

1. **Bring-up (at §S3):**
   ```bash
   bash dashboard/setup.sh
   ```
   Clones/pulls Layer 0, installs deps, copies the hub, registers the
   device tunnel, starts hub + cloudflared only if not already running,
   renders the page. Prints a status block with the URL — relay it.
   Re-running is harmless (no duplicate hubs / re-clones / double
   tunnels). It will say `creds: NOT set` until step 2.

2. **Connect the account (at §S5, after the user gives the key):**
   ```bash
   bash dashboard/setup.sh creds <KEY> <SECRET> paper   # or: live
   ```
   Writes creds to `agent_config` and re-renders the live page.

URL to give the user:
`https://device-<serial>.clawln.app/static/us-equity.html`

## Keeping it fresh

`setup.sh` is the one-time / occasional bring-up. For the recurring
refresh use the lighter primitive directly — `python3 dashboard/render.py`
(no clone/pip, just re-reads data and rewrites the page):

- **Every session start** — fresh numbers when the user opens the page.
- **On the Gateway cron during market hours** — page stays current even
  when the user isn't chatting (cron runs render.py, not setup.sh).
- **After any trade / strategy change** — feed + strategy panel update.

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
