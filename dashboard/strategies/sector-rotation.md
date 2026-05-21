# Strategy: Sector Momentum Rotation (template id: `sector-rotation`)

Rotate monthly into the strongest 2 of 9 SPDR sector ETFs. Source:
classic sector momentum (Asness, Faber); works best in sideways /
mildly trending markets.

## Universe
9 SPDR sector ETFs:
`XLK` (tech) · `XLF` (financials) · `XLE` (energy) · `XLV` (healthcare) ·
`XLI` (industrials) · `XLP` (cons. staples) · `XLY` (cons. disc.) ·
`XLU` (utilities) · `XLB` (materials).

## Activation gate
Activate only when **SPY is within ±2% of its 50DMA** (sideways
market — sector dispersion is biggest here). In strong trends, single
broad index outperforms rotation.

## Entry / rebalance
**1st trading day of each month at 09:35 ET**, rank the 9 sectors by
**trailing 3-month return** and hold top 2 equal-weight at 30% each
(60% total deployed, 40% cash buffer). Drop any sector that fell out of
top 2; buy any new entrant.

## Exit
- Monthly rebalance.
- Strategy-level: SPY moves > ±5% from 50DMA → pause (regime change).

## Position sizing
30% per sector × 2 = 60% deployed.

## Daily activity ritual

Even though rebalance is monthly, the strategy provides daily research
content — sector relative strength shifts every day:

Write in `agent_config.user_locale`'s language. One example (zh-CN):

```bash
P=/home/storyclaw/.openclaw/workspace-alpaca-us-stock-trader/skills/alpaca-us-stock/dashboard
python3 $P/broadcast.py AGENT \
  "板块 3M 动量排了一下:XLK 领先(+8.4),XLF/XLV/XLI 紧随,XLE 垫底(-3.2)" \
  --actor "[SectorRotation]"
```

Add a rebalance preview row on Wed (~9 days before month-end). On
rebalance day use `strategy.py` (for state) + `trade.py` (for the
ETF buy/sell pair, one DECIDE row each).

## Risk caveats
- Sector ETFs in concentrated baskets (XLE = 25+ energy names, XLF =
  ~70 banks) — strategy implicitly takes on sector concentration risk.
- Lags badly in strongly trending markets where breadth is narrow
  (e.g., 2023 tech-only run). Activation gate is the protection.
- 3-month lookback can chase late-cycle sectors. Consider 6-month for
  a smoother variant if backtests show better.
