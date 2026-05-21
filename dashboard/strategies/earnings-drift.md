# Strategy: Earnings Drift Rider (template id: `earnings-drift`)

Ride the post-earnings drift on held names that beat expectations.
Source: Bernard & Thomas (1989) PEAD — one of the most-replicated
anomalies in academic finance. Long-only, event-driven, low frequency
but very narrative-rich(每天 earnings 日历都有事可看).

## Universe
**Held names + active watchlist** (don't blind-trade arbitrary
earnings — only ones the agent already knows the fundamentals on).

## Activation gate
Always "active" in the background — it doesn't take a market regime,
it takes individual earnings events. The agent should check the
earnings calendar **every Morning Brief** regardless.

## Entry
For each held / watchlist name with a recent earnings event:
- EPS surprise **> 0** (beat consensus), AND
- Next-day price reaction **> +2%** at close, AND
- No more than 3 concurrent positions from this strategy.

→ Buy **10% of equity** at the day-after-reaction open.

## Exit
- **5 trading day hold**, then market-close exit, OR
- Trailing stop **-3%** from intra-hold high, whichever fires first.

## Position sizing
10% per event × max 3 concurrent = up to 30% deployed.

## Daily activity ritual — this is the broadcast-rich one

The earnings calendar generates **a lot of natural daily content** even
when no entry triggers:

Write in `agent_config.user_locale`'s language. One example (zh-CN):

```bash
P=/home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard
python3 $P/broadcast.py AGENT \
  "今天 earnings 留意:NVDA(持仓)盘后 / CRM 盘后 · watchlist 里没人发" \
  --actor "[EarningsDrift]"
```

After each release, broadcast the surprise + reaction. On days with no
relevant earnings, still emit 1 line saying so (proves the scan ran)
+ point at the next relevant one. On entry trigger, use `trade.py
--broadcast "..."` (it writes DECIDE + ORDER for you).

## Risk caveats
- PEAD has degraded since publication — works best on **positive**
  surprises (left-tail / misses no longer show clean drift). Long-only.
- Limiting to held names + watchlist means we miss the bulk of the
  PEAD universe, but it stays interpretable and doesn't chase noise.
  If you want to expand, do it deliberately (whitelist of 30+ names).
- Don't enter on **giant** beats (>15%) — those tend to gap and then
  retrace within a week. Strategy works best on moderate beats (2-8%).
