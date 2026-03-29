import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../utils.js";

export function registerAccountTools(server: McpServer): void {
  server.tool(
    "alpaca_get_account",
    "Get account information including equity, buying power, cash balance, and account status",
    {},
    async () => {
      const client = getClient();
      const [account, clock] = await Promise.all([
        client.getAccount(),
        client.getClock(),
      ]);

      const equity = parseFloat(account.equity);
      const lastEquity = parseFloat(account.last_equity);
      const dailyPnl = equity - lastEquity;
      const dailyPnlPct = lastEquity > 0 ? (dailyPnl / lastEquity) * 100 : 0;

      return {
        content: [
          {
            type: "text",
            text: `## 📊 Account Overview

| Field | Value |
|-------|-------|
| **Account** | ${account.account_number} |
| **Status** | ${account.status} |
| **Equity** | $${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })} |
| **Cash** | $${parseFloat(account.cash).toLocaleString(undefined, { minimumFractionDigits: 2 })} |
| **Buying Power** | $${parseFloat(account.buying_power).toLocaleString(undefined, { minimumFractionDigits: 2 })} |
| **Long Market Value** | $${parseFloat(account.long_market_value).toLocaleString(undefined, { minimumFractionDigits: 2 })} |
| **Daily P&L** | ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} (${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%) |
| **Day Trades** | ${account.daytrade_count} / 3 ${account.pattern_day_trader ? "⚠️ PDT" : ""} |

### Market Status
- **Market**: ${clock.is_open ? "🟢 OPEN" : "🔴 CLOSED"}
- **Next ${clock.is_open ? "Close" : "Open"}**: ${clock.is_open ? clock.next_close : clock.next_open}

${account.trading_blocked ? "⚠️ **Trading is currently blocked on this account**" : ""}`,
          },
        ],
      };
    }
  );
}
