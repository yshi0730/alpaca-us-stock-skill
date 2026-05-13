import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient, formatMode } from "../utils.js";
import { formatMoney, formatPct, formatQty, normalizeDecimalString, toFiniteNumber } from "../precision.js";
import { recordTrade } from "../storage/queries.js";
import type { OrderSide, OrderType, TimeInForce } from "../alpaca/types.js";

export function registerTradingTools(server: McpServer): void {
  server.tool(
    "alpaca_place_order",
    "Place a stock or crypto order. Decimal quantities are preserved for fractional shares and crypto. IMPORTANT: Always confirm with user before manual live orders.",
    {
      symbol: z.string().describe("Ticker symbol, e.g. AAPL or BTC/USD if supported by the account"),
      side: z.enum(["buy", "sell"]).describe("Order side"),
      qty: z.string().optional().describe("Share/unit quantity, supports up to 9 decimal places. Use this OR notional, not both."),
      notional: z.string().optional().describe("Dollar notional amount, supports decimal cents and sub-cent crypto routing where Alpaca allows it. Use this OR qty."),
      type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).default("market").describe("Order type"),
      time_in_force: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).default("day").describe("Time in force"),
      limit_price: z.string().optional().describe("Limit price, supports up to 8 decimal places"),
      stop_price: z.string().optional().describe("Stop price, supports up to 8 decimal places"),
      trail_percent: z.string().optional().describe("Trail percentage, supports decimal values"),
      extended_hours: z.boolean().optional().default(false).describe("Allow extended hours trading"),
    },
    async ({ symbol, side, qty, notional, type, time_in_force, limit_price, stop_price, trail_percent, extended_hours }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();

      let normalizedQty: string | undefined;
      let normalizedNotional: string | undefined;
      let normalizedLimitPrice: string | undefined;
      let normalizedStopPrice: string | undefined;
      let normalizedTrailPercent: string | undefined;

      try {
        normalizedQty = qty ? normalizeDecimalString(qty, 9) : undefined;
        normalizedNotional = notional ? normalizeDecimalString(notional, 8) : undefined;
        normalizedLimitPrice = limit_price ? normalizeDecimalString(limit_price, 8) : undefined;
        normalizedStopPrice = stop_price ? normalizeDecimalString(stop_price, 8) : undefined;
        normalizedTrailPercent = trail_percent ? normalizeDecimalString(trail_percent, 6) : undefined;
      } catch (err) {
        return {
          content: [{ type: "text", text: `Invalid numeric input: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      if (!normalizedQty && !normalizedNotional) {
        return {
          content: [{ type: "text", text: "Must specify either qty or notional." }],
          isError: true,
        };
      }

      if (normalizedQty && normalizedNotional) {
        return {
          content: [{ type: "text", text: "Specify only one of qty or notional, not both." }],
          isError: true,
        };
      }

      try {
        const order = await client.placeOrder({
          symbol: sym,
          side: side as OrderSide,
          qty: normalizedQty,
          notional: normalizedNotional,
          type: type as OrderType,
          time_in_force: time_in_force as TimeInForce,
          limit_price: normalizedLimitPrice,
          stop_price: normalizedStopPrice,
          trail_percent: normalizedTrailPercent,
          extended_hours,
        });

        recordTrade({
          order_id: order.id,
          symbol: sym,
          side,
          qty: toFiniteNumber(order.qty || normalizedQty),
          status: order.status,
        });

        const details = [
          `| **Order ID** | \`${order.id}\` |`,
          `| **Symbol** | ${sym} |`,
          `| **Side** | ${side.toUpperCase()} |`,
          `| **Type** | ${type.toUpperCase()} |`,
          `| **Qty / Notional** | ${normalizedQty ? formatQty(normalizedQty) : formatMoney(normalizedNotional!)} |`,
          `| **Time in Force** | ${time_in_force.toUpperCase()} |`,
          `| **Status** | ${order.status} |`,
        ];

        if (normalizedLimitPrice) details.push(`| **Limit Price** | ${formatMoney(normalizedLimitPrice)} |`);
        if (normalizedStopPrice) details.push(`| **Stop Price** | ${formatMoney(normalizedStopPrice)} |`);
        if (normalizedTrailPercent) details.push(`| **Trail %** | ${formatQty(normalizedTrailPercent)}% |`);

        return {
          content: [
            {
              type: "text",
              text: `## Order Placed ${formatMode()}\n\n| Field | Value |\n|-------|-------|\n${details.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `## Order Failed\n\n**Error**: ${err instanceof Error ? err.message : String(err)}\n\n**Attempted**: ${side.toUpperCase()} ${normalizedQty || normalizedNotional} ${sym} (${type})`,
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

      let table = `## Orders (${orders.length})\n\n`;
      table += "| Time | Symbol | Side | Type | Qty | Price | Status |\n";
      table += "|------|--------|------|------|-----|-------|--------|\n";

      for (const o of orders) {
        const time = o.submitted_at?.split("T")[0] || "-";
        const price = o.filled_avg_price
          ? formatMoney(o.filled_avg_price)
          : o.limit_price
            ? `lmt ${formatMoney(o.limit_price)}`
            : "market";

        table += `| ${time} | **${o.symbol}** | ${o.side.toUpperCase()} | ${o.type} | ${formatQty(o.qty)} | ${price} | ${o.status} |\n`;
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
        return { content: [{ type: "text", text: `Order \`${order_id}\` has been canceled.` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to cancel order: ${err instanceof Error ? err.message : String(err)}` }],
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
      return { content: [{ type: "text", text: "All open orders have been canceled." }] };
    }
  );

  server.tool(
    "alpaca_get_positions",
    "Get all current stock and crypto positions with high-precision quantities and P&L",
    {},
    async () => {
      const client = getClient();
      const positions = await client.getPositions();

      if (positions.length === 0) {
        return { content: [{ type: "text", text: "No open positions." }] };
      }

      let totalValue = 0;
      let totalPnl = 0;

      let table = "## Current Positions\n\n";
      table += "| Symbol | Qty | Avg Cost | Current | Mkt Value | P&L | P&L% | Today |\n";
      table += "|--------|-----|----------|---------|-----------|-----|------|-------|\n";

      for (const p of positions) {
        const avgCost = toFiniteNumber(p.avg_entry_price);
        const current = toFiniteNumber(p.current_price);
        const mktValue = toFiniteNumber(p.market_value);
        const pnl = toFiniteNumber(p.unrealized_pl);
        const pnlPct = toFiniteNumber(p.unrealized_plpc) * 100;
        const today = toFiniteNumber(p.change_today) * 100;
        const icon = pnl >= 0 ? "+" : "";

        totalValue += mktValue;
        totalPnl += pnl;

        table += `| **${p.symbol}** | ${formatQty(p.qty)} | ${formatMoney(avgCost)} | ${formatMoney(current)} | ${formatMoney(mktValue)} | ${icon}${formatMoney(pnl)} | ${formatPct(pnlPct)} | ${formatPct(today)} |\n`;
      }

      table += `\n**Total Market Value**: ${formatMoney(totalValue)}`;
      table += `\n**Total Unrealized P&L**: ${totalPnl >= 0 ? "+" : ""}${formatMoney(totalPnl)}`;

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_close_position",
    "Close a specific stock or crypto position",
    {
      symbol: z.string().describe("Symbol to close"),
      qty: z.string().optional().describe("Number of shares/units to close, supports up to 9 decimal places. Omit to close entire position."),
    },
    async ({ symbol, qty }) => {
      const client = getClient();
      const sym = symbol.toUpperCase();

      let normalizedQty: string | undefined;
      try {
        normalizedQty = qty ? normalizeDecimalString(qty, 9) : undefined;
      } catch (err) {
        return {
          content: [{ type: "text", text: `Invalid quantity: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      try {
        const order = await client.closePosition(sym, normalizedQty);
        recordTrade({
          order_id: order.id,
          symbol: sym,
          side: "sell",
          qty: toFiniteNumber(order.qty || normalizedQty),
          status: order.status,
        });
        return {
          content: [
            {
              type: "text",
              text: `Closing position: ${normalizedQty ? formatQty(normalizedQty) : "ALL"} units of ${sym}\nOrder ID: \`${order.id}\` | Status: ${order.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to close position: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "alpaca_close_all_positions",
    "Close ALL positions. DANGER: This will liquidate the entire portfolio.",
    {},
    async () => {
      const client = getClient();
      await client.closeAllPositions();
      return { content: [{ type: "text", text: "All positions are being closed. Orders have been submitted." }] };
    }
  );
}
