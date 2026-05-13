import { z } from "zod";
import { v4 as uuid } from "uuid";
import { fork, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../utils.js";
import { formatMoney, formatPct, formatQty, toFiniteNumber } from "../precision.js";
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
    "Start the monitoring daemon for real-time price alerts and strategy execution. Supports high-frequency checks for active trading.",
    {
      symbols: z.array(z.string()).optional().describe("Additional symbols to monitor beyond those in active strategies"),
      cron_interval_minutes: z.number().optional().default(1).describe("Legacy check interval in minutes. Ignored when cron_interval_seconds is set."),
      cron_interval_seconds: z.number().int().min(15).max(3600).optional().describe("High-frequency check interval in seconds. Use 15-60 seconds for active trading."),
    },
    async ({ symbols, cron_interval_minutes, cron_interval_seconds }) => {
      if (monitorProcess && !monitorProcess.killed) {
        return { content: [{ type: "text", text: "Monitor is already running. Use alpaca_stop_monitor to stop it first." }] };
      }

      const apiKey = getConfig("alpaca_api_key");
      const apiSecret = getConfig("alpaca_api_secret");
      const mode = getConfig("alpaca_mode") || "paper";

      if (!apiKey || !apiSecret) {
        return {
          content: [{ type: "text", text: "Alpaca API is not configured. Run alpaca_configure first." }],
          isError: true,
        };
      }

      const intervalSeconds = cron_interval_seconds ?? Math.max(60, Math.round((cron_interval_minutes ?? 1) * 60));
      const builtDaemonPath = resolve(__dirname, "../monitor-daemon.js");
      const sourceDaemonPath = resolve(__dirname, "../monitor-daemon.ts");
      const daemonPath = existsSync(builtDaemonPath) ? builtDaemonPath : sourceDaemonPath;

      monitorProcess = fork(daemonPath, [], {
        env: {
          ...process.env,
          ALPACA_API_KEY: apiKey,
          ALPACA_API_SECRET: apiSecret,
          ALPACA_MODE: mode,
          MONITOR_SYMBOLS: (symbols || []).join(","),
          MONITOR_CRON_INTERVAL_SECONDS: String(intervalSeconds),
        },
        stdio: "pipe",
      });

      monitorProcess.on("exit", () => {
        monitorProcess = null;
      });

      return {
        content: [
          {
            type: "text",
            text: `## Monitor Started

| Field | Value |
|-------|-------|
| PID | ${monitorProcess.pid} |
| Mode | ${mode} |
| Extra symbols | ${symbols?.join(", ") || "none"} |
| High-frequency interval | every ${intervalSeconds} seconds |

The monitor will stream prices, run strategy/risk checks every ${intervalSeconds} seconds, and store alerts for alpaca_get_monitor_status or alpaca_cron_tick.`,
          },
        ],
      };
    }
  );

  server.tool(
    "alpaca_cron_tick",
    "Gateway cron pairing entrypoint. Call this from OpenClaw/TalentHub cron to wake the agent for high-frequency risk checks, status reminders, and scheduled strategy work.",
    {
      mode: z
        .enum(["heartbeat", "risk_check", "strategy_check", "premarket", "postmarket"])
        .default("heartbeat")
        .describe("Cron task mode. Use heartbeat for frequent wakeups, risk_check every 1-5 minutes during market hours."),
      symbols: z.array(z.string()).optional().describe("Optional watchlist symbols for this tick"),
      acknowledge_alerts: z.boolean().optional().default(false).describe("Acknowledge alerts after reporting them"),
    },
    async ({ mode, symbols, acknowledge_alerts }) => {
      const isRunning = monitorProcess && !monitorProcess.killed;
      const alerts = getUnacknowledgedAlerts();
      const rules = getAlertRules(true);
      const lines: string[] = [];

      lines.push(`## Cron Tick: ${mode}`);
      lines.push(`- Monitor daemon: ${isRunning ? `running (PID ${monitorProcess!.pid})` : "stopped"}`);
      lines.push(`- Active alert rules: ${rules.length}`);
      lines.push(`- Unacknowledged alerts: ${alerts.length}`);

      try {
        const client = getClient();
        const [account, positions] = await Promise.all([
          client.getAccount(),
          client.getPositions(),
        ]);
        const equity = toFiniteNumber(account.equity);
        const lastEquity = toFiniteNumber(account.last_equity);
        const dailyPnl = equity - lastEquity;
        const dailyPnlPct = lastEquity > 0 ? (dailyPnl / lastEquity) * 100 : 0;
        const totalPnl = positions.reduce((sum, p) => sum + toFiniteNumber(p.unrealized_pl), 0);

        lines.push(`- Equity: ${formatMoney(equity)}`);
        lines.push(`- Daily P&L: ${dailyPnl >= 0 ? "+" : ""}${formatMoney(dailyPnl)} (${formatPct(dailyPnlPct)})`);
        lines.push(`- Open positions: ${positions.length}`);
        lines.push(`- Unrealized P&L: ${totalPnl >= 0 ? "+" : ""}${formatMoney(totalPnl)}`);

        if (positions.length > 0) {
          lines.push("");
          lines.push("| Symbol | Qty | Current | P&L | P&L% |");
          lines.push("|--------|-----|---------|-----|------|");
          for (const p of positions.slice(0, 20)) {
            lines.push(
              `| **${p.symbol}** | ${formatQty(p.qty)} | ${formatMoney(p.current_price)} | ${toFiniteNumber(p.unrealized_pl) >= 0 ? "+" : ""}${formatMoney(p.unrealized_pl)} | ${formatPct(toFiniteNumber(p.unrealized_plpc) * 100)} |`
            );
          }
        }
      } catch (err) {
        lines.push(`- Account check: unavailable (${err instanceof Error ? err.message : String(err)})`);
      }

      if (symbols && symbols.length > 0) {
        lines.push(`- Watchlist for this tick: ${symbols.map((s) => s.toUpperCase()).join(", ")}`);
      }

      if (alerts.length > 0) {
        lines.push("");
        lines.push("### Alerts");
        for (const alert of alerts.slice(0, 10)) {
          lines.push(`- ${alert.created_at} **${alert.symbol}**: ${alert.message}`);
        }
      }

      if (acknowledge_alerts && alerts.length > 0) {
        acknowledgeAlerts();
        lines.push("");
        lines.push("Alerts acknowledged.");
      }

      lines.push("");
      lines.push("Gateway pairing: schedule this tool via cron every 1-5 minutes during market hours, plus premarket/postmarket jobs for briefings.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
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
      return { content: [{ type: "text", text: "Monitor stopped." }] };
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

      let text = `## Monitor Status\n\n`;
      text += `**Daemon**: ${isRunning ? "Running (PID " + monitorProcess!.pid + ")" : "Stopped"}\n\n`;

      if (alerts.length === 0) {
        text += "No unacknowledged alerts.\n";
      } else {
        text += `### Unacknowledged Alerts (${alerts.length})\n\n`;
        text += "| Time | Symbol | Message |\n";
        text += "|------|--------|--------|\n";
        for (const a of alerts) {
          text += `| ${a.created_at} | **${a.symbol}** | ${a.message} |\n`;
        }
      }

      if (acknowledge && alerts.length > 0) {
        acknowledgeAlerts();
        text += "\nAll alerts acknowledged.";
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
    "Add a price alert rule for a stock or crypto symbol",
    {
      symbol: z.string().describe("Stock or crypto symbol"),
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
            text: `Alert created: **${symbol.toUpperCase()}** ${indicator} ${opMap[op]} ${formatQty(value)}\nID: \`${id}\`\nAction: ${action_type}`,
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
      return { content: [{ type: "text", text: `Alert rule \`${alert_id}\` removed.` }] };
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

      let table = `## Alert Rules (${rules.length})\n\n`;
      table += "| ID | Symbol | Condition | Active | Last Triggered |\n";
      table += "|----|--------|-----------|--------|----------------|\n";

      const opMap: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
      for (const r of rules) {
        table += `| \`${r.id.slice(0, 8)}\` | **${r.symbol}** | ${r.condition.indicator} ${opMap[r.condition.op] || r.condition.op} ${formatQty(r.condition.value)} | ${r.is_active ? "yes" : "no"} | ${r.last_triggered_at || "never"} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );
}
