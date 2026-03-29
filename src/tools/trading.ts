import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, formatMode } from "../utils.js";
import { recordTrade } from "../storage/queries.js";
import type { OrderSide, OrderType, TimeInForce } from "../alpaca/types.js";

export function registerTradingTools(server: McpServer): void {
  server.tool(
    "alpaca_place_order",
    "Place a stock order (buy or sell). IMPORTANT: Always confirm with user before placing orders, especially in live mode.",
    {
      symbol: z.string().describe("Stock ticker symbol"),
      side: z.enum(["buy", "sell"]).describe("Order side"),
      qty: z.string().optional().describe("Number of shares (use this OR notional, not both)"),
      notional: z.string().optional().describe("Dollar amount to buy/sell (use this OR qty)"),
      type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).default("market").describe("Order type"),
      time_in_force: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).default("day").describe("Time in force"),
      limit_price: z.string().optional().describe("Limit price (required for limit/stop_limit orders)"),
      stop_price: z.string().optional().describe("Stop price (required for stop/stop_limit orders)"),
      trail_percent: z.string().optional().describe("Trail percentage for trailing stop orders"),
      extended_hours: z.boolean().optional().default(false).describe("Allow extended hours trading"),
    },
    async ({ symbol, side, qty, notional, type, time_in_force, limit_price, stop_price, trail_percent, extended_hours }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();

      if (!qty && !notional) {
        return {
          content: [{ type: "text", text: "❌ Must specify either `qty` (shares) or `notional` (dollar amount)." }],
          isError: true,
        };
      }

      try {
        const order = await client.placeOrder({
          symbol: sym,
          side: side as OrderSide,
          qty,
          notional,
          type: type as OrderType,
          time_in_force: time_in_force as TimeInForce,
          limit_price,
          stop_price,
          trail_percent,
          extended_hours,
        });

        // Record in local DB
        recordTrade({
          order_id: order.id,
          symbol: sym,
          side,
          qty: parseFloat(order.qty),
          status: order.status,
        });

        const details = [
          `| **Order ID** | \`${order.id}\` |`,
          `| **Symbol** | ${sym} |`,
          `| **Side** | ${side.toUpperCase()} |`,
          `| **Type** | ${type.toUpperCase()} |`,
          `| **Qty** | ${qty || `$${notional}`} |`,
          `| **Time in Force** | ${time_in_force.toUpperCase()} |`,
          `| **Status** | ${order.status} |`,
        ];

        if (limit_price) details.push(`| **Limit Price** | $${limit_price} |`);
        if (stop_price) details.push(`| **Stop Price** | $${stop_price} |`);
        if (trail_percent) details.push(`| **Trail %** | ${trail_percent}% |`);

        return {
          content: [
            {
              type: "text",
              text: `## ✅ Order Placed ${formatMode()}\n\n| Field | Value |\n|-------|-------|\n${details.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `## ❌ Order Failed\n\n**Error**: ${err instanceof Error ? err.message : String(err)}\n\n**Attempted**: ${side.toUpperCase()} ${qty || `$${notional}`} ${sym} (${type})`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_get_orders",
    "List recent orders with their status",
    {
      status: z.enum(["open", "closed", "all"]).optional().default("all").describe("Filter by order status"),
      symbols: z.string().optional().describe("Comma-separated symbols to filter"),
      limit: z.number().optional().default(20).describe("Max number of orders to return"),
    },
    async ({ status, symbols, limit }) => {
      const client = getClient();
      const orders = await client.getOrders({ status, symbols, limit });

      if (orders.length === 0) {
        return { content: [{ type: "text", text: "No orders found." }] };
      }

      let table = `## 📋 Orders (${orders.length})\n\n`;
      table += "| Time | Symbol | Side | Type | Qty | Price | Status |\n";
      table += "|------|--------|------|------|-----|-------|--------|\n";

      for (const o of orders) {
        const time = o.submitted_at?.split("T")[0] || "—";
        const price = o.filled_avg_price
          ? `$${parseFloat(o.filled_avg_price).toFixed(2)}`
          : o.limit_price
            ? `lmt $${o.limit_price}`
            : "market";
        const statusIcon =
          o.status === "filled"
            ? "✅"
            : o.status === "canceled"
              ? "❌"
              : o.status === "new" || o.status === "accepted"
                ? "⏳"
                : "⚪";

        table += `| ${time} | **${o.symbol}** | ${o.side.toUpperCase()} | ${o.type} | ${o.qty} | ${price} | ${statusIcon} ${o.status} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_cancel_order",
    "Cancel a specific open order by its order ID",
    { order_id: z.string().describe("Order ID to cancel") },
    async ({ order_id }) => {
      const client = getClient();
      try {
        await client.cancelOrder(order_id);
        return { content: [{ type: "text", text: `✅ Order \`${order_id}\` has been canceled.` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to cancel order: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_cancel_all_orders",
    "Cancel ALL open orders. Use with caution.",
    {},
    async () => {
      const client = getClient();
      await client.cancelAllOrders();
      return { content: [{ type: "text", text: "✅ All open orders have been canceled." }] };
    }
  );

  server.tool(
    "alpaca_get_positions",
    "Get all current stock positions with P&L",
    {},
    async () => {
      const client = getClient();
      const positions = await client.getPositions();

      if (positions.length === 0) {
        return { content: [{ type: "text", text: "📭 No open positions." }] };
      }

      let totalValue = 0;
      let totalPnl = 0;

      let table = "## 💼 Current Positions\n\n";
      table += "| Symbol | Qty | Avg Cost | Current | Mkt Value | P&L | P&L% | Today |\n";
      table += "|--------|-----|----------|---------|-----------|-----|------|-------|\n";

      for (const p of positions) {
        const qty = parseFloat(p.qty);
        const avgCost = parseFloat(p.avg_entry_price);
        const current = parseFloat(p.current_price);
        const mktValue = parseFloat(p.market_value);
        const pnl = parseFloat(p.unrealized_pl);
        const pnlPct = parseFloat(p.unrealized_plpc) * 100;
        const today = parseFloat(p.change_today) * 100;
        const icon = pnl >= 0 ? "🟢" : "🔴";

        totalValue += mktValue;
        totalPnl += pnl;

        table += `| **${p.symbol}** | ${qty} | $${avgCost.toFixed(2)} | $${current.toFixed(2)} | $${mktValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} | ${icon} $${pnl.toFixed(2)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ${today >= 0 ? "+" : ""}${today.toFixed(2)}% |\n`;
      }

      const totalIcon = totalPnl >= 0 ? "🟢" : "🔴";
      table += `\n**Total Market Value**: $${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      table += `\n**Total Unrealized P&L**: ${totalIcon} $${totalPnl.toFixed(2)}`;

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_close_position",
    "Close (sell) a specific stock position",
    {
      symbol: z.string().describe("Stock symbol to close"),
      qty: z.string().optional().describe("Number of shares to close (omit to close entire position)"),
    },
    async ({ symbol, qty }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();
      try {
        const order = await client.closePosition(sym, qty);
        recordTrade({
          order_id: order.id,
          symbol: sym,
          side: "sell",
          qty: parseFloat(order.qty),
          status: order.status,
        });
        return {
          content: [
            {
              type: "text",
              text: `✅ Closing position: ${qty || "ALL"} shares of ${sym}\nOrder ID: \`${order.id}\` | Status: ${order.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Failed to close position: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_close_all_positions",
    "Close ALL positions. DANGER: This will liquidate your entire portfolio!",
    {},
    async () => {
      const client = getClient();
      await client.closeAllPositions();
      return { content: [{ type: "text", text: "⚠️ All positions are being closed. Orders have been submitted." }] };
    }
  );
}
