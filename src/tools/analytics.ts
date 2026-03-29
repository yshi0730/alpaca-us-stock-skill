import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../utils.js";
import {
  getTradeJournal,
  addTradeNote,
  getPositionSnapshots,
} from "../storage/queries.js";

export function registerAnalyticsTools(server: McpServer): void {
  server.tool(
    "alpaca_get_performance",
    "Get portfolio performance report over a specified period",
    {
      period: z
        .enum(["1d", "1w", "1m", "3m", "1y", "all"])
        .default("1m")
        .describe("Time period for the report"),
    },
    async ({ period }) => {
      const client = getClient();
      const [account, positions] = await Promise.all([
        client.getAccount(),
        client.getPositions(),
      ]);

      const equity = parseFloat(account.equity);
      const cash = parseFloat(account.cash);
      const lastEquity = parseFloat(account.last_equity);
      const dailyPnl = equity - lastEquity;

      // Get historical snapshots
      const limitMap: Record<string, number> = {
        "1d": 1,
        "1w": 7,
        "1m": 30,
        "3m": 90,
        "1y": 365,
        all: 9999,
      };
      const snapshots = getPositionSnapshots(limitMap[period] || 30);

      let text = `## 📈 Portfolio Performance (${period})\n\n`;
      text += `### Current State\n`;
      text += `| Metric | Value |\n|--------|-------|\n`;
      text += `| **Equity** | $${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })} |\n`;
      text += `| **Cash** | $${cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} |\n`;
      text += `| **Invested** | $${(equity - cash).toLocaleString(undefined, { minimumFractionDigits: 2 })} |\n`;
      text += `| **Today's P&L** | ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} |\n`;
      text += `| **Positions** | ${positions.length} |\n`;

      // Position breakdown
      if (positions.length > 0) {
        let totalPnl = 0;
        text += `\n### Position Breakdown\n\n`;
        text += `| Symbol | Weight | P&L | P&L% |\n`;
        text += `|--------|--------|-----|------|\n`;

        const sortedPositions = [...positions].sort(
          (a, b) => Math.abs(parseFloat(b.market_value)) - Math.abs(parseFloat(a.market_value))
        );

        for (const p of sortedPositions) {
          const mktVal = parseFloat(p.market_value);
          const weight = (mktVal / equity) * 100;
          const pnl = parseFloat(p.unrealized_pl);
          const pnlPct = parseFloat(p.unrealized_plpc) * 100;
          totalPnl += pnl;
          const icon = pnl >= 0 ? "🟢" : "🔴";
          text += `| **${p.symbol}** | ${weight.toFixed(1)}% | ${icon} $${pnl.toFixed(2)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% |\n`;
        }

        text += `\n**Total Unrealized P&L**: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}\n`;
      }

      // Historical trend from snapshots
      if (snapshots.length > 1) {
        const oldest = snapshots[snapshots.length - 1];
        const newest = snapshots[0];
        const periodReturn = ((newest.total_equity - oldest.total_equity) / oldest.total_equity) * 100;

        text += `\n### Period Trend\n`;
        text += `- **Start Equity**: $${oldest.total_equity.toFixed(2)}\n`;
        text += `- **End Equity**: $${newest.total_equity.toFixed(2)}\n`;
        text += `- **Period Return**: ${periodReturn >= 0 ? "+" : ""}${periodReturn.toFixed(2)}%\n`;
        text += `- **Data Points**: ${snapshots.length}\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_get_trade_journal",
    "Get trade journal / history with optional filters",
    {
      start_date: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      symbol: z.string().optional().describe("Filter by symbol"),
    },
    async ({ start_date, end_date, symbol }) => {
      const trades = getTradeJournal({ start_date, end_date, symbol });

      if (trades.length === 0) {
        return { content: [{ type: "text", text: "No trades found for the given filters." }] };
      }

      let text = `## 📝 Trade Journal (${trades.length} trades)\n\n`;
      text += `| Date | Symbol | Side | Qty | Price | Status | Note |\n`;
      text += `|------|--------|------|-----|-------|--------|------|\n`;

      let totalBuy = 0;
      let totalSell = 0;

      for (const t of trades) {
        const date = (t.created_at as string).split("T")[0];
        const price = t.price ? `$${(t.price as number).toFixed(2)}` : "—";
        const note = t.note ? (t.note as string).slice(0, 30) : "—";
        text += `| ${date} | **${t.symbol}** | ${(t.side as string).toUpperCase()} | ${t.qty} | ${price} | ${t.status} | ${note} |\n`;

        if (t.side === "buy" && t.total) totalBuy += t.total as number;
        if (t.side === "sell" && t.total) totalSell += t.total as number;
      }

      text += `\n**Total Bought**: $${totalBuy.toFixed(2)} | **Total Sold**: $${totalSell.toFixed(2)}`;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_add_trade_note",
    "Add a note to a specific trade (for journaling and review)",
    {
      trade_id: z.string().describe("Trade ID from the journal"),
      note: z.string().describe("Note text (reasoning, lessons learned, etc.)"),
    },
    async ({ trade_id, note }) => {
      const updated = addTradeNote(trade_id, note);
      if (!updated) {
        return { content: [{ type: "text", text: `Trade not found: ${trade_id}` }], isError: true };
      }
      return { content: [{ type: "text", text: `✅ Note added to trade \`${trade_id}\`.` }] };
    }
  );

  server.tool(
    "alpaca_review_session",
    "Generate a comprehensive trading review / post-mortem for a period",
    {
      period: z
        .enum(["1d", "1w", "1m", "3m"])
        .default("1w")
        .describe("Review period"),
      include_suggestions: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include AI-friendly analysis data for generating suggestions"),
    },
    async ({ period, include_suggestions }) => {
      const client = getClient();

      const periodDays: Record<string, number> = { "1d": 1, "1w": 7, "1m": 30, "3m": 90 };
      const days = periodDays[period] || 7;
      const startDate = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

      const [account, positions, trades] = await Promise.all([
        client.getAccount(),
        client.getPositions(),
        Promise.resolve(getTradeJournal({ start_date: startDate })),
      ]);

      const equity = parseFloat(account.equity);

      // Analyze trades
      const buys = trades.filter((t) => t.side === "buy");
      const sells = trades.filter((t) => t.side === "sell");
      const symbolSet = new Set(trades.map((t) => t.symbol as string));

      let text = `## 📋 Trading Review — Last ${period}\n\n`;
      text += `### Summary\n`;
      text += `| Metric | Value |\n|--------|-------|\n`;
      text += `| **Current Equity** | $${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })} |\n`;
      text += `| **Total Trades** | ${trades.length} |\n`;
      text += `| **Buy Orders** | ${buys.length} |\n`;
      text += `| **Sell Orders** | ${sells.length} |\n`;
      text += `| **Symbols Traded** | ${symbolSet.size} (${[...symbolSet].join(", ")}) |\n`;
      text += `| **Open Positions** | ${positions.length} |\n`;

      // P&L by symbol from positions
      if (positions.length > 0) {
        text += `\n### Open Position P&L\n\n`;
        let winners = 0;
        let losers = 0;
        for (const p of positions) {
          const pnl = parseFloat(p.unrealized_pl);
          if (pnl >= 0) winners++;
          else losers++;
        }
        text += `- Winners: ${winners} | Losers: ${losers}\n`;
        text += `- Win Rate: ${positions.length > 0 ? ((winners / positions.length) * 100).toFixed(1) : 0}%\n`;
      }

      // Trading activity by day
      const byDay: Record<string, number> = {};
      for (const t of trades) {
        const day = (t.created_at as string).split("T")[0];
        byDay[day] = (byDay[day] || 0) + 1;
      }
      text += `\n### Activity by Day\n`;
      for (const [day, count] of Object.entries(byDay).sort()) {
        text += `- ${day}: ${count} trades\n`;
      }

      if (include_suggestions) {
        text += `\n### 📊 Data for Analysis\n\n`;
        text += `Below is raw data the agent can use to generate actionable suggestions:\n\n`;
        text += "```json\n";
        text += JSON.stringify(
          {
            equity,
            period,
            trade_count: trades.length,
            symbols_traded: [...symbolSet],
            positions: positions.map((p) => ({
              symbol: p.symbol,
              qty: p.qty,
              pnl: p.unrealized_pl,
              pnl_pct: p.unrealized_plpc,
              change_today: p.change_today,
            })),
            trades_by_day: byDay,
          },
          null,
          2
        );
        text += "\n```\n";
        text += `\n> Agent: Use this data to identify patterns, suggest improvements, and flag risk concerns.`;
      }

      return { content: [{ type: "text", text }] };
    }
  );
}
