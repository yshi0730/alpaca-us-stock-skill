import type { BacktestMetrics, BacktestTrade } from "../alpaca/types.js";

export function computeMetrics(
  equityCurve: Array<{ date: string; equity: number }>,
  trades: BacktestTrade[],
  initialCapital: number
): BacktestMetrics {
  if (equityCurve.length === 0) {
    return emptyMetrics();
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const totalReturn = (finalEquity - initialCapital) / initialCapital;

  // Annualized return
  const tradingDays = equityCurve.length;
  const years = tradingDays / 252;
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : totalReturn;

  // Daily returns for volatility & Sharpe
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyReturns.push(
      (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity
    );
  }

  const avgDailyReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;

  const dailyStd = stddev(dailyReturns);
  const annualizedVol = dailyStd * Math.sqrt(252);

  // Sharpe (risk-free rate = 0 for simplicity)
  const sharpe = annualizedVol > 0 ? annualizedReturn / annualizedVol : 0;

  // Max drawdown
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = (peak - point.equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Calmar ratio
  const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  // Trade stats
  const completedRoundTrips = getCompletedTrades(trades);
  const winningTrades = completedRoundTrips.filter((t) => t.pnl > 0);
  const losingTrades = completedRoundTrips.filter((t) => t.pnl <= 0);

  const totalTrades = completedRoundTrips.length;
  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;

  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((s, t) => s + t.pnlPct, 0) / winningTrades.length
      : 0;

  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((s, t) => s + t.pnlPct, 0) / losingTrades.length
      : 0;

  const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    total_return_pct: totalReturn * 100,
    annualized_return_pct: annualizedReturn * 100,
    sharpe_ratio: sharpe,
    max_drawdown_pct: maxDrawdown * 100,
    win_rate_pct: winRate,
    total_trades: totalTrades,
    winning_trades: winningTrades.length,
    losing_trades: losingTrades.length,
    avg_win_pct: avgWin,
    avg_loss_pct: avgLoss,
    profit_factor: profitFactor === Infinity ? 999 : profitFactor,
    calmar_ratio: calmar,
    volatility_pct: annualizedVol * 100,
  };
}

interface RoundTrip {
  symbol: string;
  pnl: number;
  pnlPct: number;
}

function getCompletedTrades(trades: BacktestTrade[]): RoundTrip[] {
  const roundTrips: RoundTrip[] = [];
  const openPositions: Record<string, { qty: number; avgPrice: number }> = {};

  for (const trade of trades) {
    if (trade.side === "buy") {
      if (!openPositions[trade.symbol]) {
        openPositions[trade.symbol] = { qty: 0, avgPrice: 0 };
      }
      const pos = openPositions[trade.symbol];
      const totalCost = pos.avgPrice * pos.qty + trade.price * trade.qty;
      pos.qty += trade.qty;
      pos.avgPrice = pos.qty > 0 ? totalCost / pos.qty : 0;
    } else if (trade.side === "sell") {
      const pos = openPositions[trade.symbol];
      if (!pos || pos.qty <= 0) continue;

      const sellQty = Math.min(trade.qty, pos.qty);
      const pnl = (trade.price - pos.avgPrice) * sellQty;
      const pnlPct = pos.avgPrice > 0 ? ((trade.price - pos.avgPrice) / pos.avgPrice) * 100 : 0;

      roundTrips.push({ symbol: trade.symbol, pnl, pnlPct });
      pos.qty -= sellQty;
      if (pos.qty <= 0) delete openPositions[trade.symbol];
    }
  }

  return roundTrips;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function emptyMetrics(): BacktestMetrics {
  return {
    total_return_pct: 0,
    annualized_return_pct: 0,
    sharpe_ratio: 0,
    max_drawdown_pct: 0,
    win_rate_pct: 0,
    total_trades: 0,
    winning_trades: 0,
    losing_trades: 0,
    avg_win_pct: 0,
    avg_loss_pct: 0,
    profit_factor: 0,
    calmar_ratio: 0,
    volatility_pct: 0,
  };
}
