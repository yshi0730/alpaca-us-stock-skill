import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../utils.js";
import { getStrategy } from "../storage/queries.js";
import { saveBacktest, getBacktest } from "../storage/queries.js";
import { runBacktest } from "../backtest/engine.js";

export function registerBacktestTools(server: McpServer): void {
  server.tool(
    "alpaca_backtest",
    "Run a historical backtest for a saved strategy. Returns performance metrics and trade log.",
    {
      strategy_id: z.string().describe("ID of the strategy to backtest"),
      symbols: z.array(z.string()).optional().describe("Override universe symbols (uses strategy universe if omitted)"),
      start_date: z.string().describe("Backtest start date (YYYY-MM-DD)"),
      end_date: z.string().describe("Backtest end date (YYYY-MM-DD)"),
      initial_capital: z.number().optional().default(100000).describe("Starting capital in USD"),
    },
    async ({ strategy_id, symbols, start_date, end_date, initial_capital }) => {
      const strategy = getStrategy(strategy_id);
      if (!strategy) {
        return { content: [{ type: "text", text: `Strategy not found: ${strategy_id}` }], isError: true };
      }

      const client = getClient();
      const universe = (symbols || strategy.universe).map((s) => s.toUpperCase());

      try {
        const result = await runBacktest({
          client,
          strategy,
          symbols: universe,
          startDate: start_date,
          endDate: end_date,
          initialCapital: initial_capital,
        });

        saveBacktest(result);

        const m = result.metrics;
        let text = `## 📈 Backtest Results: ${strategy.name}\n\n`;
        text += `**Period**: ${start_date} → ${end_date} | **Capital**: $${initial_capital.toLocaleString()}\n\n`;
        text += `### Performance Metrics\n\n`;
        text += `| Metric | Value |\n`;
        text += `|--------|-------|\n`;
        text += `| **Total Return** | ${m.total_return_pct >= 0 ? "+" : ""}${m.total_return_pct.toFixed(2)}% |\n`;
        text += `| **Annualized Return** | ${m.annualized_return_pct >= 0 ? "+" : ""}${m.annualized_return_pct.toFixed(2)}% |\n`;
        text += `| **Sharpe Ratio** | ${m.sharpe_ratio.toFixed(2)} |\n`;
        text += `| **Max Drawdown** | -${m.max_drawdown_pct.toFixed(2)}% |\n`;
        text += `| **Calmar Ratio** | ${m.calmar_ratio.toFixed(2)} |\n`;
        text += `| **Volatility** | ${m.volatility_pct.toFixed(2)}% |\n`;
        text += `| **Win Rate** | ${m.win_rate_pct.toFixed(1)}% |\n`;
        text += `| **Profit Factor** | ${m.profit_factor.toFixed(2)} |\n`;
        text += `| **Total Trades** | ${m.total_trades} |\n`;
        text += `| **Avg Win** | +${m.avg_win_pct.toFixed(2)}% |\n`;
        text += `| **Avg Loss** | ${m.avg_loss_pct.toFixed(2)}% |\n`;

        text += `\n### Trade Log (last 20)\n\n`;
        text += `| Date | Symbol | Side | Qty | Price | Value | Reason |\n`;
        text += `|------|--------|------|-----|-------|-------|--------|\n`;
        for (const t of result.trades.slice(-20)) {
          text += `| ${t.date} | ${t.symbol} | ${t.side} | ${t.qty} | $${t.price.toFixed(2)} | $${t.value.toFixed(2)} | ${t.reason} |\n`;
        }

        text += `\n**Backtest ID**: \`${result.id}\``;
        text += `\n> Use **alpaca_get_backtest_results** to retrieve this result later.`;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Backtest failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_get_backtest_results",
    "Retrieve a previously run backtest result",
    { backtest_id: z.string().describe("Backtest ID") },
    async ({ backtest_id }) => {
      const result = getBacktest(backtest_id);
      if (!result) {
        return { content: [{ type: "text", text: `Backtest not found: ${backtest_id}` }], isError: true };
      }

      const m = result.metrics;
      let text = `## 📊 Backtest: ${backtest_id.slice(0, 8)}\n\n`;
      text += `**Period**: ${result.config.start_date} → ${result.config.end_date}\n`;
      text += `**Symbols**: ${result.config.symbols.join(", ")}\n`;
      text += `**Initial Capital**: $${result.config.initial_capital.toLocaleString()}\n\n`;
      text += `| Metric | Value |\n|--------|-------|\n`;
      text += `| Total Return | ${m.total_return_pct.toFixed(2)}% |\n`;
      text += `| Sharpe | ${m.sharpe_ratio.toFixed(2)} |\n`;
      text += `| Max DD | -${m.max_drawdown_pct.toFixed(2)}% |\n`;
      text += `| Win Rate | ${m.win_rate_pct.toFixed(1)}% |\n`;
      text += `| Trades | ${m.total_trades} |\n`;

      return { content: [{ type: "text", text }] };
    }
  );
}
