import { z } from "zod";
import { v4 as uuid } from "uuid";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);
let monitorProcess: ChildProcess | null = null;

const AGENT_ID = "alpaca-us-stock-trader";
const CRON_REPORT_INSTRUCTIONS =
  "Save the report to the workspace/dashboard first. If no chat/channel is attached to this cron wakeup, do not fail and do not ask the user for a channel; keep the report archived and only surface urgent action items when a channel is available.";
const WEB_UI_CRON_DELIVERY_ARGS = ["--session", "current", "--no-deliver"];

function archiveCronReport(mode: string, text: string): string | null {
  try {
    const workspaceRoot =
      process.env.OPENCLAW_WORKSPACE_PATH ||
      process.env.WORKSPACE_PATH ||
      resolve(process.env.HOME || process.cwd(), ".openclaw", `workspace-${AGENT_ID}`);
    const filesDir = resolve(workspaceRoot, "files");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = resolve(filesDir, `cron-${mode}-${timestamp}.md`);
    const latestPath = resolve(filesDir, "latest-cron-report.md");

    mkdirSync(filesDir, { recursive: true });
    writeFileSync(reportPath, text, "utf8");
    writeFileSync(latestPath, text, "utf8");
    return reportPath;
  } catch {
    return null;
  }
}

async function runOpenClaw(args: string[]): Promise<string> {
  const command = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: 60_000,
    windowsHide: true,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

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
    "Cron wakeup entrypoint. OpenClaw Gateway cron should wake the agent with a message that asks it to call this tool for high-frequency risk checks, status reminders, and scheduled strategy work.",
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
      lines.push("Gateway cron: schedule current-session jobs with --no-deliver that wake this agent and instruct it to call alpaca_cron_tick, avoiding implicit channel:last delivery.");

      const reportText = lines.join("\n");
      const archivePath = archiveCronReport(mode, reportText);
      if (archivePath) {
        lines.push(`- Report archived: ${archivePath}`);
      } else {
        lines.push("- Report archive: unavailable");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "alpaca_setup_gateway_cron",
    "Create OpenClaw Gateway cron jobs for this trading agent. Use this when cron is unavailable, not paired, missing, or when autonomous trading reminders need to be enabled. Defaults to current-session Web UI jobs with --no-deliver so OpenClaw does not require channel:last.",
    {
      risk_check_interval_minutes: z.number().int().min(5).max(1440).optional().default(60).describe("How often to wake the agent for proactive reports. Default is hourly."),
      timezone: z.string().optional().default("America/New_York").describe("Timezone for market-hour schedules."),
      channel: z.string().optional().describe("Optional external delivery channel for summaries, e.g. slack, telegram, discord. Leave empty for Web UI/current-session reports."),
      to: z.string().optional().describe("Optional external delivery target, e.g. channel:C123 or a chat id. Requires channel. Leave empty for Web UI/current-session reports."),
    },
    async ({ risk_check_interval_minutes, timezone, channel, to }) => {
      const jobs = [
        {
          name: "Alpaca market-hours risk check",
          args: [
            "cron",
            "add",
            "--name",
            "Alpaca market-hours risk check",
            "--every",
            `${risk_check_interval_minutes}m`,
            ...WEB_UI_CRON_DELIVERY_ARGS,
            "--agent",
            AGENT_ID,
            "--message",
            `Run alpaca_cron_tick with mode='risk_check'. Check positions, alerts, guardrails, and active strategy status. ${CRON_REPORT_INSTRUCTIONS}`,
          ],
        },
        {
          name: "Alpaca premarket briefing",
          args: [
            "cron",
            "add",
            "--name",
            "Alpaca premarket briefing",
            "--cron",
            "30 8 * * 1-5",
            "--tz",
            timezone,
            ...WEB_UI_CRON_DELIVERY_ARGS,
            "--agent",
            AGENT_ID,
            "--message",
            `Run alpaca_cron_tick with mode='premarket'. Produce a concise premarket briefing focused on held positions, active strategies, risk alerts, and today's scheduled catalysts. ${CRON_REPORT_INSTRUCTIONS}`,
          ],
        },
        {
          name: "Alpaca postmarket snapshot",
          args: [
            "cron",
            "add",
            "--name",
            "Alpaca postmarket snapshot",
            "--cron",
            "30 16 * * 1-5",
            "--tz",
            timezone,
            ...WEB_UI_CRON_DELIVERY_ARGS,
            "--agent",
            AGENT_ID,
            "--message",
            `Run alpaca_cron_tick with mode='postmarket'. Record a closing portfolio snapshot and summarize trades, alerts, guardrail status, and next scheduled actions. ${CRON_REPORT_INSTRUCTIONS}`,
          ],
        },
      ];

      const externalDeliveryArgs = channel && to ? ["--announce", "--best-effort-deliver", "--channel", channel, "--to", to] : [];
      const lines: string[] = ["## Automatic Reports"];

      try {
        const [gatewayStatus, cronStatus, existingJobs] = await Promise.all([
          runOpenClaw(["gateway", "status"]).catch((err) => `gateway status failed: ${err.message}`),
          runOpenClaw(["cron", "status"]).catch((err) => `cron status failed: ${err.message}`),
          runOpenClaw(["cron", "list"]).catch(() => ""),
        ]);

        const statusText = `${gatewayStatus}\n${cronStatus}`.toLowerCase();
        if (statusText.includes("pairing required")) {
          return {
            content: [
              {
                type: "text",
                text: "Gateway pairing is required. Confirm pairing, then I will continue setting up hourly reports.",
              },
            ],
            isError: true,
          };
        }

        for (const job of jobs) {
          if (existingJobs.includes(job.name)) {
            lines.push(`- ${job.name}: already enabled`);
            continue;
          }

          const args = externalDeliveryArgs.length > 0
            ? job.args.filter((arg) => arg !== "--no-deliver").concat(externalDeliveryArgs)
            : job.args;

          try {
            await runOpenClaw(args);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const looksLikeChannelError = /channel|conversation|target|announce/i.test(message);

            if (externalDeliveryArgs.length > 0 && looksLikeChannelError) {
              await runOpenClaw(job.args);
              lines.push(`- ${job.name}: external channel failed, created as Web UI/current-session job`);
              continue;
            }

            throw err;
          }

          lines.push(`- ${job.name}: created`);
        }

        lines.push("");
        lines.push(`Automatic reports are enabled. Default report cadence: every ${risk_check_interval_minutes} minutes.`);
        lines.push(channel && to ? `Delivery: ${channel} (${to}) with best-effort fallback, plus workspace/dashboard archive.` : "Delivery: current Web UI session with runner fallback disabled, plus workspace/dashboard archive. No channel:last lookup is used.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const interval = `${risk_check_interval_minutes}m`;
        const reason = message.toLowerCase().includes("pairing")
          ? "Gateway pairing is required."
          : /channel|conversation|target|announce/i.test(message)
            ? "OpenClaw is still trying to resolve a channel. This version uses current session and --no-deliver instead of channel:last."
            : "Gateway cron is temporarily unavailable.";
        return {
          content: [
            {
              type: "text",
              text: `Automatic reports are not enabled yet: ${reason}\n\nNext: once Gateway cron is available, I will report every ${interval}.`,
            },
          ],
          isError: true,
        };
      }
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
