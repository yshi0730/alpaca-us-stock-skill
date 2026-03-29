import { z } from "zod";
import { v4 as uuid } from "uuid";
import { fork, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  saveAlertRule,
  getAlertRules,
  removeAlertRule,
  getUnacknowledgedAlerts,
  acknowledgeAlerts,
} from "../storage/queries.js";
import { getConfig } from "../storage/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let monitorProcess: ChildProcess | null = null;

export function registerMonitorTools(server: McpServer): void {
  server.tool(
    "alpaca_start_monitor",
    "Start the monitoring daemon for real-time price alerts and strategy execution",
    {
      symbols: z.array(z.string()).optional().describe("Additional symbols to monitor beyond those in active strategies"),
      cron_interval_minutes: z.number().optional().default(5).describe("Cron check interval in minutes"),
    },
    async ({ symbols, cron_interval_minutes }) => {
      if (monitorProcess && !monitorProcess.killed) {
        return { content: [{ type: "text", text: "⚠️ Monitor is already running. Use **alpaca_stop_monitor** to stop it first." }] };
      }

      const apiKey = getConfig("alpaca_api_key");
      const apiSecret = getConfig("alpaca_api_secret");
      const mode = getConfig("alpaca_mode") || "paper";

      if (!apiKey || !apiSecret) {
        return {
          content: [{ type: "text", text: "❌ Alpaca API not configured. Run **alpaca_configure** first." }],
          isError: true,
        };
      }

      const daemonPath = resolve(__dirname, "../../scripts/monitor-daemon.ts");

      monitorProcess = fork(daemonPath, [], {
        env: {
          ...process.env,
          ALPACA_API_KEY: apiKey,
          ALPACA_API_SECRET: apiSecret,
          ALPACA_MODE: mode,
          MONITOR_SYMBOLS: (symbols || []).join(","),
          MONITOR_CRON_INTERVAL: String(cron_interval_minutes),
        },
        stdio: "pipe",
      });

      monitorProcess.on("exit", (code) => {
        monitorProcess = null;
      });

      return {
        content: [
          {
            type: "text",
            text: `## ✅ Monitor Started

- **PID**: ${monitorProcess.pid}
- **Mode**: ${mode}
- **Extra symbols**: ${symbols?.join(", ") || "none"}
- **Cron interval**: every ${cron_interval_minutes} minutes

The monitor will:
1. 📡 Stream real-time prices via WebSocket for watched symbols
2. ⏰ Check strategy conditions every ${cron_interval_minutes} minutes
3. 🔔 Generate alerts when conditions are met

Use **alpaca_get_monitor_status** to check alerts and status.`,
          },
        ],
      };
    }
  );

  server.tool(
    "alpaca_stop_monitor",
    "Stop the monitoring daemon",
    {},
    async () => {
      if (!monitorProcess || monitorProcess.killed) {
        return { content: [{ type: "text", text: "Monitor is not running." }] };
      }
      monitorProcess.kill("SIGTERM");
      monitorProcess = null;
      return { content: [{ type: "text", text: "✅ Monitor stopped." }] };
    }
  );

  server.tool(
    "alpaca_get_monitor_status",
    "Get monitor daemon status and unacknowledged alerts",
    {
      acknowledge: z.boolean().optional().default(false).describe("Acknowledge all alerts after reading"),
    },
    async ({ acknowledge }) => {
      const isRunning = monitorProcess && !monitorProcess.killed;
      const alerts = getUnacknowledgedAlerts();

      let text = `## 📡 Monitor Status\n\n`;
      text += `**Daemon**: ${isRunning ? "🟢 Running (PID " + monitorProcess!.pid + ")" : "🔴 Stopped"}\n\n`;

      if (alerts.length === 0) {
        text += "No unacknowledged alerts.\n";
      } else {
        text += `### 🔔 Unacknowledged Alerts (${alerts.length})\n\n`;
        text += "| Time | Symbol | Message |\n";
        text += "|------|--------|--------|\n";
        for (const a of alerts) {
          text += `| ${a.created_at} | **${a.symbol}** | ${a.message} |\n`;
        }
      }

      if (acknowledge && alerts.length > 0) {
        acknowledgeAlerts();
        text += "\n✅ All alerts acknowledged.";
      }

      const rules = getAlertRules(true);
      if (rules.length > 0) {
        text += `\n\n### Active Alert Rules (${rules.length})\n\n`;
        for (const r of rules) {
          text += `- **${r.symbol}**: ${r.condition.indicator} ${r.condition.op} ${r.condition.value}\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_add_alert",
    "Add a price alert rule for a stock",
    {
      symbol: z.string().describe("Stock symbol"),
      indicator: z.enum(["price", "price_change_pct", "volume", "volume_ratio"]).describe("What to monitor"),
      op: z.enum(["gt", "lt", "gte", "lte"]).describe("Comparison operator"),
      value: z.number().describe("Threshold value"),
      action_type: z.enum(["notify", "trade"]).default("notify").describe("What to do when triggered"),
    },
    async ({ symbol, indicator, op, value, action_type }) => {
      const id = uuid();
      saveAlertRule({
        id,
        symbol: symbol.toUpperCase(),
        condition: { indicator, op, value },
        action: { type: action_type },
        is_active: true,
      });

      const opMap: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
      return {
        content: [
          {
            type: "text",
            text: `✅ Alert created: **${symbol.toUpperCase()}** ${indicator} ${opMap[op]} ${value}\nID: \`${id}\`\nAction: ${action_type}`,
          },
        ],
      };
    }
  );

  server.tool(
    "alpaca_remove_alert",
    "Remove an alert rule",
    { alert_id: z.string().describe("Alert rule ID to remove") },
    async ({ alert_id }) => {
      const removed = removeAlertRule(alert_id);
      if (!removed) {
        return { content: [{ type: "text", text: `Alert rule not found: ${alert_id}` }], isError: true };
      }
      return { content: [{ type: "text", text: `✅ Alert rule \`${alert_id}\` removed.` }] };
    }
  );

  server.tool(
    "alpaca_get_alerts",
    "List all alert rules",
    { active_only: z.boolean().optional().default(false).describe("Only show active alerts") },
    async ({ active_only }) => {
      const rules = getAlertRules(active_only);
      if (rules.length === 0) {
        return { content: [{ type: "text", text: "No alert rules configured." }] };
      }

      let table = `## 🔔 Alert Rules (${rules.length})\n\n`;
      table += "| ID | Symbol | Condition | Active | Last Triggered |\n";
      table += "|----|--------|-----------|--------|----------------|\n";

      const opMap: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
      for (const r of rules) {
        table += `| \`${r.id.slice(0, 8)}\` | **${r.symbol}** | ${r.condition.indicator} ${opMap[r.condition.op] || r.condition.op} ${r.condition.value} | ${r.is_active ? "✅" : "⬜"} | ${r.last_triggered_at || "never"} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );
}
