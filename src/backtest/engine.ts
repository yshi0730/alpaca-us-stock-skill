import { v4 as uuid } from "uuid";
import type { AlpacaClient } from "../alpaca/client.js";
import type {
  Strategy,
  BacktestResult,
  BacktestMetrics,
  BacktestTrade,
  Bar,
} from "../alpaca/types.js";
import { computeMetrics } from "./metrics.js";

interface BacktestParams {
  client: AlpacaClient;
  strategy: Strategy;
  symbols: string[];
  startDate: string;
  endDate: string;
  initialCapital: number;
}

interface SimPosition {
  symbol: string;
  qty: number;
  avgPrice: number;
}

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const { client, strategy, symbols, startDate, endDate, initialCapital } = params;

  // Fetch historical data for all symbols
  const barsBySymbol: Record<string, Bar[]> = {};
  for (const sym of symbols) {
    barsBySymbol[sym] = await client.getBars({
      symbol: sym,
      timeframe: "1Day",
      start: startDate,
      end: endDate,
      limit: 10000,
    });
  }

  // Get all unique dates across symbols
  const dateSet = new Set<string>();
  for (const bars of Object.values(barsBySymbol)) {
    for (const bar of bars) {
      dateSet.add(bar.t.split("T")[0]);
    }
  }
  const dates = [...dateSet].sort();

  // Simulation state
  let cash = initialCapital;
  const positions: Record<string, SimPosition> = {};
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  const priceHistory: Record<string, number[]> = {};

  for (const sym of symbols) {
    priceHistory[sym] = [];
  }

  // Run simulation day by day
  for (const date of dates) {
    // Get current prices
    const prices: Record<string, number> = {};
    for (const sym of symbols) {
      const bar = barsBySymbol[sym].find((b) => b.t.split("T")[0] === date);
      if (bar) {
        prices[sym] = bar.c;
        priceHistory[sym].push(bar.c);
      }
    }

    // Evaluate strategy rules
    for (const rule of strategy.rules) {
      if (rule.trigger !== "cron" && rule.trigger !== "manual") continue;

      for (const sym of symbols) {
        if (!prices[sym]) continue;
        const history = priceHistory[sym];

        const conditionsMet = rule.conditions.every((cond) => {
          return evaluateCondition(cond, prices[sym], history, positions[sym]);
        });

        if (!conditionsMet && rule.conditions.length > 0) continue;

        // Execute actions
        for (const action of rule.actions) {
          const targetSymbol = action.symbol === "$symbol" ? sym : action.symbol || sym;
          const price = prices[targetSymbol];
          if (!price) continue;

          if (action.type === "buy") {
            const equity = cash + totalPositionValue(positions, prices);
            let qty = 0;

            if (action.sizing === "percent_of_equity" && action.value) {
              const amount = equity * (action.value / 100);
              qty = Math.floor(amount / price);
            } else if (action.sizing === "notional" && action.value) {
              qty = Math.floor(action.value / price);
            } else if (action.sizing === "shares" && action.value) {
              qty = action.value;
            }

            // Risk check: max position
            if (strategy.risk_management?.max_position_pct) {
              const maxAmount = equity * (strategy.risk_management.max_position_pct / 100);
              const existingValue = (positions[targetSymbol]?.qty || 0) * price;
              const buyAmount = qty * price;
              if (existingValue + buyAmount > maxAmount) {
                qty = Math.floor((maxAmount - existingValue) / price);
              }
            }

            if (qty > 0 && cash >= qty * price) {
              cash -= qty * price;
              if (!positions[targetSymbol]) {
                positions[targetSymbol] = { symbol: targetSymbol, qty: 0, avgPrice: 0 };
              }
              const pos = positions[targetSymbol];
              const totalCost = pos.avgPrice * pos.qty + price * qty;
              pos.qty += qty;
              pos.avgPrice = totalCost / pos.qty;

              trades.push({
                date,
                symbol: targetSymbol,
                side: "buy",
                qty,
                price,
                value: qty * price,
                reason: describeConditions(rule.conditions),
              });
            }
          } else if (action.type === "sell") {
            const pos = positions[targetSymbol];
            if (!pos || pos.qty <= 0) continue;

            let qty = pos.qty;
            if (action.sizing === "shares" && action.value) {
              qty = Math.min(action.value, pos.qty);
            }

            cash += qty * price;
            trades.push({
              date,
              symbol: targetSymbol,
              side: "sell",
              qty,
              price,
              value: qty * price,
              reason: describeConditions(rule.conditions),
            });

            pos.qty -= qty;
            if (pos.qty <= 0) delete positions[targetSymbol];
          }
        }
      }
    }

    // Check stop loss / take profit
    if (strategy.risk_management) {
      for (const sym of Object.keys(positions)) {
        const pos = positions[sym];
        const price = prices[sym];
        if (!pos || !price) continue;

        const pnlPct = ((price - pos.avgPrice) / pos.avgPrice) * 100;

        if (strategy.risk_management.stop_loss_pct && pnlPct <= -strategy.risk_management.stop_loss_pct) {
          cash += pos.qty * price;
          trades.push({
            date,
            symbol: sym,
            side: "sell",
            qty: pos.qty,
            price,
            value: pos.qty * price,
            reason: `Stop loss at ${pnlPct.toFixed(1)}%`,
          });
          delete positions[sym];
        } else if (strategy.risk_management.take_profit_pct && pnlPct >= strategy.risk_management.take_profit_pct) {
          cash += pos.qty * price;
          trades.push({
            date,
            symbol: sym,
            side: "sell",
            qty: pos.qty,
            price,
            value: pos.qty * price,
            reason: `Take profit at ${pnlPct.toFixed(1)}%`,
          });
          delete positions[sym];
        }
      }
    }

    // Record equity curve
    const equity = cash + totalPositionValue(positions, prices);
    equityCurve.push({ date, equity });
  }

  const metrics = computeMetrics(equityCurve, trades, initialCapital);

  return {
    id: uuid(),
    strategy_id: strategy.id,
    config: {
      strategy_id: strategy.id,
      symbols,
      start_date: startDate,
      end_date: endDate,
      initial_capital: initialCapital,
    },
    metrics,
    trades,
    equity_curve: equityCurve,
    created_at: new Date().toISOString(),
  };
}

function totalPositionValue(positions: Record<string, SimPosition>, prices: Record<string, number>): number {
  let total = 0;
  for (const pos of Object.values(positions)) {
    total += pos.qty * (prices[pos.symbol] || 0);
  }
  return total;
}

function evaluateCondition(
  cond: { indicator: string; params?: Record<string, number | string>; op: string; value?: number; target?: string },
  currentPrice: number,
  history: number[],
  position?: SimPosition
): boolean {
  const period = (cond.params?.period as number) || 20;

  let indicatorValue: number;

  switch (cond.indicator) {
    case "sma": {
      if (history.length < period) return false;
      indicatorValue = sma(history, period);
      break;
    }
    case "rsi": {
      if (history.length < period + 1) return false;
      indicatorValue = rsi(history, period);
      break;
    }
    case "price":
      indicatorValue = currentPrice;
      break;
    case "price_change_pct": {
      if (history.length < 2) return false;
      indicatorValue = ((currentPrice - history[history.length - 2]) / history[history.length - 2]) * 100;
      break;
    }
    case "price_vs_52w_high": {
      if (history.length < 252) return false;
      const high52 = Math.max(...history.slice(-252));
      indicatorValue = currentPrice / high52;
      break;
    }
    case "volume_ratio":
      indicatorValue = 1; // simplified: assume 1x average
      break;
    case "position_size":
      indicatorValue = position?.qty || 0;
      break;
    default:
      return false;
  }

  // Handle cross_above/cross_below against target SMA
  if (cond.op === "cross_above" || cond.op === "cross_below") {
    if (!cond.target) return false;
    const targetPeriod = parseInt(cond.target.replace("sma_", "")) || 200;
    if (history.length < Math.max(period, targetPeriod) + 1) return false;

    const shortNow = sma(history, period);
    const longNow = sma(history, targetPeriod);
    const shortPrev = sma(history.slice(0, -1), period);
    const longPrev = sma(history.slice(0, -1), targetPeriod);

    if (cond.target === "price") {
      return cond.op === "cross_above"
        ? shortPrev <= currentPrice && shortNow > currentPrice
        : shortPrev >= currentPrice && shortNow < currentPrice;
    }

    return cond.op === "cross_above"
      ? shortPrev <= longPrev && shortNow > longNow
      : shortPrev >= longPrev && shortNow < longNow;
  }

  const target = cond.value ?? 0;
  switch (cond.op) {
    case "gt": return indicatorValue > target;
    case "lt": return indicatorValue < target;
    case "gte": return indicatorValue >= target;
    case "lte": return indicatorValue <= target;
    case "eq": return indicatorValue === target;
    default: return false;
  }
}

function sma(data: number[], period: number): number {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rsi(data: number[], period: number): number {
  const changes = [];
  for (let i = data.length - period; i < data.length; i++) {
    changes.push(data[i] - data[i - 1]);
  }
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function describeConditions(conditions: Array<{ indicator: string; op: string; value?: number; target?: string }>): string {
  if (conditions.length === 0) return "scheduled";
  return conditions.map((c) => `${c.indicator} ${c.op} ${c.value ?? c.target ?? ""}`).join(" & ");
}
