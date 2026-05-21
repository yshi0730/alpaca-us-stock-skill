# Strategy: Quality Mean-Reversion (template id: `quality-mr`)

Buy high-quality large-caps when they temporarily oversell in a
downtrending market. Quality picks WHO; mean-reversion picks WHEN.

## Universe
10 high-ROE large caps:
`AAPL, MSFT, GOOGL, META, V, MA, JPM, UNH, COST, LLY`.

## Activation gate
Activate only when **SPY is in confirmed drawdown**: SPY is **below
50DMA** AND down **≥5% from its 60-day high**. In normal markets, this
strategy sits dormant.

## Entry
For each name in the universe, **buy 10% of equity** when:
- RSI(14) **< 30** (oversold), AND
- Price **< 50DMA** (confirming the dip is real, not a head-fake), AND
- Less than 4 positions from this strategy currently open.

## Exit
- RSI(14) **> 50** → sell.
- Hard stop **-5%** from entry.
- Strategy-level: SPY reclaims 50DMA → close all and pause.

## Position sizing
10% per name; max 4 concurrent → up to 40% deployed.

## Daily activity ritual

Every weekday Morning Brief, scan all 10 names and broadcast:

Write in `agent_config.user_locale`'s language. One example (zh-CN);
when a name is near threshold, emit 1 line per such name + 1 closing
summary:

```bash
P=/home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard
python3 $P/broadcast.py AGENT \
  "QualityMR 扫了一圈 10 只:AAPL RSI 34.2 逼近 30 入场线,其余中性" \
  --actor "[QualityMR-Scan]" --level done
```

For held positions, similarly broadcast RSI progress toward the exit
threshold when it gets close.

## Risk caveats
- Catching falling knives if regime changes (bear market → entries pile
  up at lower lows). The -5% hard stop and SPY-50DMA reclaim exit are
  the only protections.
- 10 names × 10% sizing = up to 40% in correlated tech/finance/health
  largecaps in a crisis. Don't let it concentrate.
