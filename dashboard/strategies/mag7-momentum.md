# Strategy: Mag7 Momentum Rotation (template id: `mag7-momentum`)

Rotate weekly into the strongest 3 of the Magnificent Seven.

## Universe
`AAPL, MSFT, GOOGL, NVDA, META, TSLA, AMZN` (7 names, fixed).

## Activation gate
Activate only when **SPY > 50DMA** AND **VIX < 25** (trending market,
low storm risk). If the gate fails, broadcast HOLD and do nothing this
week — do NOT activate this strategy in chop or panic.

## Entry / rebalance
**Every Monday 09:35 ET**, rank the 7 by **trailing 4-week return** and
hold top 3 equal-weight at `--type market` orders. Drop any name that
fell out of top 3; buy any new entrant.

## Exit
- Drop on weekly rebalance if no longer top 3.
- Hard stop: per-name -7% from entry.
- Strategy-level circuit breaker: SPY breaks 50DMA mid-week → pause.

## Position sizing
20% of equity per name × 3 = 60% deployed, 40% cash buffer.

## Daily activity ritual (this is what fills broadcast on non-trade days)

Even when not rebalancing, every weekday Morning Brief should broadcast
the standings — this is the most visible "thinking" surface:

Write in `agent_config.user_locale`'s language. One example (zh-CN):

```bash
P=/home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard
python3 $P/broadcast.py AGENT \
  "Mag7 4 周动量排了一下:NVDA 第一(+14.2),META / AAPL 紧跟,TSLA 最弱(-2.4)" \
  --actor "[Mag7Rotation]"
```

On Friday, follow up with a 1-line Monday-rebalance preview.

## Risk caveats
- "Mag7" is a 2023+ post-hoc concept; backtests pre-2020 are mostly
  Apple + Microsoft. Concentration risk is real.
- 7 names × top-3 = high single-name dependency; one earnings miss can
  drag the whole strategy.
- Use this in confirmed bull regimes only. The activation gate is the
  protection.
