import type { StrategyRule, RiskManagement } from "../alpaca/types.js";

export interface StrategyTemplate {
  name: string;
  description: string;
  universe: string[];
  rules: StrategyRule[];
  risk_management: RiskManagement;
}

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    name: "📈 SMA Crossover (Golden/Death Cross)",
    description:
      "Classic moving average crossover strategy. Buys when short-term SMA crosses above long-term SMA (golden cross), sells on death cross. Works well in trending markets.",
    universe: ["SPY"],
    rules: [
      {
        trigger: "cron",
        schedule: "0 31 9 * * 1-5",
        conditions: [
          { indicator: "sma", params: { period: 50 }, op: "cross_above", target: "sma_200" },
        ],
        actions: [
          { type: "buy", symbol: "$symbol", sizing: "percent_of_equity", value: 90 },
        ],
      },
      {
        trigger: "cron",
        schedule: "0 31 9 * * 1-5",
        conditions: [
          { indicator: "sma", params: { period: 50 }, op: "cross_below", target: "sma_200" },
        ],
        actions: [{ type: "sell", symbol: "$symbol", sizing: "all" }],
      },
    ],
    risk_management: {
      max_position_pct: 95,
      stop_loss_pct: 8,
      take_profit_pct: 25,
      max_daily_trades: 2,
    },
  },
  {
    name: "💰 Dollar Cost Averaging (DCA)",
    description:
      "Automatically buy a fixed dollar amount at regular intervals regardless of price. Reduces timing risk and emotional trading. Best for long-term investors.",
    universe: ["VOO", "QQQ"],
    rules: [
      {
        trigger: "cron",
        schedule: "0 0 10 * * 1",
        conditions: [],
        actions: [
          { type: "buy", symbol: "VOO", sizing: "notional", value: 500 },
          { type: "buy", symbol: "QQQ", sizing: "notional", value: 500 },
        ],
      },
    ],
    risk_management: {
      max_position_pct: 50,
      max_daily_trades: 5,
    },
  },
  {
    name: "📉 Mean Reversion (RSI Oversold/Overbought)",
    description:
      "Buys when RSI drops below 30 (oversold) and sells when RSI rises above 70 (overbought). Works best in range-bound markets. Not suitable for strong trends.",
    universe: ["AAPL", "MSFT", "GOOGL", "AMZN"],
    rules: [
      {
        trigger: "cron",
        schedule: "0 31 9 * * 1-5",
        conditions: [{ indicator: "rsi", params: { period: 14 }, op: "lt", value: 30 }],
        actions: [
          { type: "buy", symbol: "$symbol", sizing: "percent_of_equity", value: 10 },
          { type: "notify", message: "RSI oversold entry: $symbol RSI < 30" },
        ],
      },
      {
        trigger: "cron",
        schedule: "0 31 9 * * 1-5",
        conditions: [{ indicator: "rsi", params: { period: 14 }, op: "gt", value: 70 }],
        actions: [
          { type: "sell", symbol: "$symbol", sizing: "all" },
          { type: "notify", message: "RSI overbought exit: $symbol RSI > 70" },
        ],
      },
    ],
    risk_management: {
      max_position_pct: 15,
      stop_loss_pct: 5,
      take_profit_pct: 10,
      max_daily_trades: 8,
    },
  },
  {
    name: "🚀 Momentum (52-Week High Breakout)",
    description:
      "Buys stocks making new 52-week highs with strong volume confirmation. Momentum strategies ride trends but require strict stop losses to limit damage in reversals.",
    universe: ["AAPL", "NVDA", "TSLA", "META", "MSFT"],
    rules: [
      {
        trigger: "cron",
        schedule: "0 45 9 * * 1-5",
        conditions: [
          { indicator: "price_vs_52w_high", op: "gte", value: 0.98 },
          { indicator: "volume_ratio", params: { period: 20 }, op: "gt", value: 1.5 },
        ],
        actions: [
          { type: "buy", symbol: "$symbol", sizing: "percent_of_equity", value: 10 },
          { type: "notify", message: "Breakout alert: $symbol near 52w high with volume surge" },
        ],
      },
      {
        trigger: "alert",
        conditions: [{ indicator: "price_change_pct", op: "lt", value: -7 }],
        actions: [
          { type: "sell", symbol: "$symbol", sizing: "all" },
          { type: "notify", message: "Momentum stop triggered: $symbol down >7%" },
        ],
      },
    ],
    risk_management: {
      max_position_pct: 15,
      stop_loss_pct: 7,
      take_profit_pct: 20,
      max_daily_trades: 5,
    },
  },
  {
    name: "🛡️ Protective Put / Trailing Stop",
    description:
      "Hold a core position with a trailing stop for downside protection. Lets winners run while cutting losses. Simple but effective risk management overlay.",
    universe: ["SPY"],
    rules: [
      {
        trigger: "alert",
        conditions: [{ indicator: "trailing_drawdown_pct", op: "gt", value: 5 }],
        actions: [
          { type: "sell", symbol: "$symbol", sizing: "all" },
          { type: "notify", message: "Trailing stop hit: $symbol dropped 5% from recent high" },
        ],
      },
      {
        trigger: "cron",
        schedule: "0 0 10 1 * *",
        conditions: [
          { indicator: "position_size", op: "eq", value: 0 },
          { indicator: "sma", params: { period: 200 }, op: "lt", target: "price" },
        ],
        actions: [
          { type: "buy", symbol: "$symbol", sizing: "percent_of_equity", value: 80 },
          { type: "notify", message: "Re-entry: $symbol above 200 SMA, buying back" },
        ],
      },
    ],
    risk_management: {
      max_position_pct: 90,
      stop_loss_pct: 5,
      max_daily_trades: 2,
    },
  },
];
