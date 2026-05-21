# Strategy: VIX Spike Buyer (template id: `vix-spike`)

Buy SPY into panic. Single-asset, event-driven, dormant most of the
year. Source: Whaley (2009); broadly used as "fear-greed" regime tilt.

## Universe
`SPY` (single asset).

## Activation gate
Strategy is permanently "active" but only **fires entries** when both:
- **VIX > 25** (panic regime), AND
- SPY dropped **≥3% over the last 2 trading days** (confirming the
  panic is in spot, not just expected forward vol).

## Entry
Single 20% slug into SPY at next open (`--type market`).
Max 1 concurrent position from this strategy.

## Exit
- VIX **< 20** (panic over) → sell, OR
- **+5% gain** from entry → sell (take profit; mean reversion captured).
- Hard stop **-4%** (rare — would mean panic kept extending).

## Position sizing
Single 20% slug. No averaging in.

## Daily activity ritual

This strategy spends most days waiting. The Morning Brief and Hourly
Pulse should still broadcast VIX state — that's the visible "I'm
watching for the regime":

Write in `agent_config.user_locale`'s language. One example for the
dormant case (zh-CN):

```bash
P=/home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard
python3 $P/broadcast.py AGENT \
  "VIX 看了眼 17.4,低波动区(还没到 25 触发线),等" \
  --actor "[VIXSpike]"
```

When VIX shifts state class or triggers, escalate to `WARN` or
`DECIDE` accordingly + use `trade.py` for the entry.

## Risk caveats
- **NEVER use VIX short instruments** (XIV/SVXY/VXX short) — 2018-02-05
  "Volmageddon" wiped XIV out overnight (-96% in a single session).
  This strategy is **only on the equity side** (long SPY).
- Confirm "panic in spot" with the 2-day drop check — otherwise can
  trigger on isolated VIX vol-of-vol without a real equity dip.
- The +5% take-profit is conservative; in 2020/03 a held position
  would have +30% if held longer. Optionally widen on user request.
