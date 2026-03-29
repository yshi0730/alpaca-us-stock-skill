import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../utils.js";
import type { Timeframe } from "../alpaca/types.js";

export function registerMarketDataTools(server: McpServer): void {
  server.tool(
    "alpaca_get_quote",
    "Get the latest real-time quote for a stock symbol",
    { symbol: z.string().describe("Stock ticker symbol, e.g. AAPL") },
    async ({ symbol }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();

      try {
        const snapshot = await client.getSnapshot(sym);
        const trade = snapshot.latestTrade;
        const quote = snapshot.latestQuote;
        const daily = snapshot.dailyBar;
        const prev = snapshot.prevDailyBar;

        const change = daily.c - prev.c;
        const changePct = prev.c > 0 ? (change / prev.c) * 100 : 0;
        const dayRange = `$${daily.l.toFixed(2)} - $${daily.h.toFixed(2)}`;

        return {
          content: [
            {
              type: "text",
              text: `## ${sym} — $${trade.p.toFixed(2)} ${change >= 0 ? "🟢" : "🔴"} ${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)

| Field | Value |
|-------|-------|
| **Last Trade** | $${trade.p.toFixed(2)} |
| **Bid** | $${quote.bp.toFixed(2)} x ${quote.bs} |
| **Ask** | $${quote.ap.toFixed(2)} x ${quote.as} |
| **Open** | $${daily.o.toFixed(2)} |
| **High** | $${daily.h.toFixed(2)} |
| **Low** | $${daily.l.toFixed(2)} |
| **Prev Close** | $${prev.c.toFixed(2)} |
| **Day Range** | ${dayRange} |
| **Volume** | ${daily.v.toLocaleString()} |
| **VWAP** | $${daily.vw.toFixed(2)} |`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to get quote for ${sym}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_get_bars",
    "Get historical price bars (candlesticks) for a stock",
    {
      symbol: z.string().describe("Stock ticker symbol"),
      timeframe: z
        .enum(["1Min", "5Min", "15Min", "30Min", "1Hour", "4Hour", "1Day", "1Week", "1Month"])
        .default("1Day")
        .describe("Bar timeframe"),
      start: z.string().optional().describe("Start date/time (ISO 8601), e.g. 2024-01-01"),
      end: z.string().optional().describe("End date/time (ISO 8601)"),
      limit: z.number().optional().default(30).describe("Number of bars to return (max 10000)"),
    },
    async ({ symbol, timeframe, start, end, limit }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();

      const bars = await client.getBars({
        symbol: sym,
        timeframe: timeframe as Timeframe,
        start,
        end,
        limit,
      });

      if (bars.length === 0) {
        return { content: [{ type: "text", text: `No bars found for ${sym} with given parameters.` }] };
      }

      let table = `## ${sym} — ${timeframe} Bars (${bars.length} bars)\n\n`;
      table += "| Date | Open | High | Low | Close | Volume | VWAP |\n";
      table += "|------|------|------|-----|-------|--------|------|\n";

      for (const bar of bars.slice(-50)) {
        const date = bar.t.split("T")[0];
        table += `| ${date} | $${bar.o.toFixed(2)} | $${bar.h.toFixed(2)} | $${bar.l.toFixed(2)} | $${bar.c.toFixed(2)} | ${bar.v.toLocaleString()} | $${bar.vw.toFixed(2)} |\n`;
      }

      if (bars.length > 50) {
        table += `\n*Showing last 50 of ${bars.length} bars*`;
      }

      // Add simple stats
      const closes = bars.map((b) => b.c);
      const high = Math.max(...bars.map((b) => b.h));
      const low = Math.min(...bars.map((b) => b.l));
      const avgVol = bars.reduce((s, b) => s + b.v, 0) / bars.length;
      const firstClose = closes[0];
      const lastClose = closes[closes.length - 1];
      const periodReturn = ((lastClose - firstClose) / firstClose) * 100;

      table += `\n\n### Summary\n`;
      table += `- **Period High**: $${high.toFixed(2)}\n`;
      table += `- **Period Low**: $${low.toFixed(2)}\n`;
      table += `- **Avg Volume**: ${Math.round(avgVol).toLocaleString()}\n`;
      table += `- **Period Return**: ${periodReturn >= 0 ? "+" : ""}${periodReturn.toFixed(2)}%\n`;

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_get_snapshot",
    "Get snapshots for multiple stocks at once (latest trade, quote, minute bar, daily bar)",
    {
      symbols: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Array of stock ticker symbols, e.g. ['AAPL', 'GOOGL', 'MSFT']"),
    },
    async ({ symbols }) => {
      const client = getClient();
      const syms = symbols.map((s) => s.toUpperCase());
      const snapshots = await client.getSnapshots(syms);

      let table = "## 📊 Multi-Stock Snapshot\n\n";
      table += "| Symbol | Price | Change | Change% | Volume | Bid | Ask |\n";
      table += "|--------|-------|--------|---------|--------|-----|-----|\n";

      for (const sym of syms) {
        const snap = snapshots[sym];
        if (!snap) {
          table += `| ${sym} | — | — | — | — | — | — |\n`;
          continue;
        }
        const price = snap.latestTrade.p;
        const prev = snap.prevDailyBar.c;
        const change = price - prev;
        const changePct = prev > 0 ? (change / prev) * 100 : 0;
        const icon = change >= 0 ? "🟢" : "🔴";

        table += `| **${sym}** | $${price.toFixed(2)} | ${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)} | ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% | ${snap.dailyBar.v.toLocaleString()} | $${snap.latestQuote.bp.toFixed(2)} | $${snap.latestQuote.ap.toFixed(2)} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_market_overview",
    "Get an overview of the US stock market (major indices, VIX, market status)",
    {},
    async () => {
      const client = getClient();
      const indexSymbols = ["SPY", "QQQ", "DIA", "IWM"];

      const [snapshots, clock] = await Promise.all([
        client.getSnapshots(indexSymbols),
        client.getClock(),
      ]);

      const nameMap: Record<string, string> = {
        SPY: "S&P 500 (SPY)",
        QQQ: "Nasdaq 100 (QQQ)",
        DIA: "Dow Jones (DIA)",
        IWM: "Russell 2000 (IWM)",
      };

      let text = `## 🇺🇸 US Market Overview\n\n`;
      text += `**Market Status**: ${clock.is_open ? "🟢 OPEN" : "🔴 CLOSED"}\n`;
      text += `**Next ${clock.is_open ? "Close" : "Open"}**: ${clock.is_open ? clock.next_close : clock.next_open}\n\n`;
      text += "| Index | Price | Change | Change% | Volume |\n";
      text += "|-------|-------|--------|---------|--------|\n";

      for (const sym of indexSymbols) {
        const snap = snapshots[sym];
        if (!snap) continue;
        const price = snap.latestTrade.p;
        const prev = snap.prevDailyBar.c;
        const change = price - prev;
        const changePct = prev > 0 ? (change / prev) * 100 : 0;
        const icon = change >= 0 ? "🟢" : "🔴";

        text += `| **${nameMap[sym]}** | $${price.toFixed(2)} | ${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)} | ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% | ${snap.dailyBar.v.toLocaleString()} |\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_screen_stocks",
    "Screen stocks based on filters (price change, volume, price range)",
    {
      symbols: z
        .array(z.string())
        .describe("List of symbols to screen"),
      min_change_pct: z.number().optional().describe("Minimum daily change percentage"),
      max_change_pct: z.number().optional().describe("Maximum daily change percentage"),
      min_volume: z.number().optional().describe("Minimum daily volume"),
      min_price: z.number().optional().describe("Minimum price"),
      max_price: z.number().optional().describe("Maximum price"),
    },
    async ({ symbols, min_change_pct, max_change_pct, min_volume, min_price, max_price }) => {
      const client = getClient();
      const syms = symbols.map((s) => s.toUpperCase());
      const snapshots = await client.getSnapshots(syms);

      const results: Array<{ symbol: string; price: number; change: number; changePct: number; volume: number }> = [];

      for (const sym of syms) {
        const snap = snapshots[sym];
        if (!snap) continue;
        const price = snap.latestTrade.p;
        const prev = snap.prevDailyBar.c;
        const change = price - prev;
        const changePct = prev > 0 ? (change / prev) * 100 : 0;
        const volume = snap.dailyBar.v;

        if (min_change_pct !== undefined && changePct < min_change_pct) continue;
        if (max_change_pct !== undefined && changePct > max_change_pct) continue;
        if (min_volume !== undefined && volume < min_volume) continue;
        if (min_price !== undefined && price < min_price) continue;
        if (max_price !== undefined && price > max_price) continue;

        results.push({ symbol: sym, price, change, changePct, volume });
      }

      results.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

      let table = `## 🔍 Stock Screener Results (${results.length} / ${syms.length} matched)\n\n`;
      table += "| Symbol | Price | Change | Change% | Volume |\n";
      table += "|--------|-------|--------|---------|--------|\n";

      for (const r of results) {
        const icon = r.change >= 0 ? "🟢" : "🔴";
        table += `| **${r.symbol}** | $${r.price.toFixed(2)} | ${icon} ${r.change >= 0 ? "+" : ""}${r.change.toFixed(2)} | ${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}% | ${r.volume.toLocaleString()} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );
}
