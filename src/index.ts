#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerSetupTools } from "./tools/setup.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMarketDataTools } from "./tools/market-data.js";
import { registerTradingTools } from "./tools/trading.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerMonitorTools } from "./tools/monitor.js";
import { registerBacktestTools } from "./tools/backtest.js";
import { registerAnalyticsTools } from "./tools/analytics.js";

const server = new McpServer({
  name: "alpaca-us-stock",
  version: "0.1.0",
});

// Register all tool groups
registerSetupTools(server);
registerAccountTools(server);
registerMarketDataTools(server);
registerTradingTools(server);
registerStrategyTools(server);
registerMonitorTools(server);
registerBacktestTools(server);
registerAnalyticsTools(server);

// Start server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
