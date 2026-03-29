import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveStrategy, listStrategies, getStrategy, deleteStrategy } from "../storage/queries.js";
import { STRATEGY_TEMPLATES } from "../strategy/templates.js";

const StrategyConditionSchema = z.object({
  indicator: z.string(),
  params: z.record(z.union([z.number(), z.string()])).optional(),
  op: z.enum(["gt", "lt", "gte", "lte", "eq", "cross_above", "cross_below"]),
  value: z.number().optional(),
  target: z.string().optional(),
});

const StrategyActionSchema = z.object({
  type: z.enum(["buy", "sell", "notify"]),
  symbol: z.string().optional(),
  sizing: z.enum(["shares", "percent_of_equity", "notional", "all"]).optional(),
  value: z.number().optional(),
  message: z.string().optional(),
});

const StrategyRuleSchema = z.object({
  trigger: z.enum(["cron", "alert", "manual"]),
  schedule: z.string().optional(),
  conditions: z.array(StrategyConditionSchema),
  actions: z.array(StrategyActionSchema),
});

const RiskManagementSchema = z.object({
  max_position_pct: z.number().optional(),
  stop_loss_pct: z.number().optional(),
  take_profit_pct: z.number().optional(),
  max_daily_trades: z.number().optional(),
});

export function registerStrategyTools(server: McpServer): void {
  server.tool(
    "alpaca_list_strategy_templates",
    "List built-in strategy templates that can be customized",
    {},
    async () => {
      let text = "## 📋 Strategy Templates\n\n";
      text += "These are ready-to-use strategy templates. Pick one and customize it for your needs.\n\n";

      for (const tmpl of STRATEGY_TEMPLATES) {
        text += `### ${tmpl.name}\n`;
        text += `${tmpl.description}\n\n`;
        text += `- **Universe**: ${tmpl.universe.join(", ")}\n`;
        text += `- **Rules**: ${tmpl.rules.length} rules\n`;
        if (tmpl.risk_management) {
          const rm = tmpl.risk_management;
          text += `- **Risk**: Max position ${rm.max_position_pct}%, SL ${rm.stop_loss_pct}%, TP ${rm.take_profit_pct}%\n`;
        }
        text += "\n---\n\n";
      }

      text += `\n> To create a strategy from a template, use **alpaca_create_strategy** and reference the template structure.`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_create_strategy",
    "Create a new trading strategy with rules and risk management",
    {
      name: z.string().describe("Strategy name"),
      description: z.string().describe("Strategy description"),
      universe: z.array(z.string()).describe("Stock symbols this strategy trades"),
      rules: z.array(StrategyRuleSchema).describe("Array of strategy rules (trigger + conditions + actions)"),
      risk_management: RiskManagementSchema.optional().describe("Risk management parameters"),
    },
    async ({ name, description, universe, rules, risk_management }) => {
      const strategy = saveStrategy({
        id: uuid(),
        name,
        description,
        universe: universe.map((s) => s.toUpperCase()),
        rules,
        risk_management,
        is_active: false,
      });

      let text = `## ✅ Strategy Created\n\n`;
      text += `| Field | Value |\n|-------|-------|\n`;
      text += `| **ID** | \`${strategy.id}\` |\n`;
      text += `| **Name** | ${name} |\n`;
      text += `| **Universe** | ${universe.join(", ")} |\n`;
      text += `| **Rules** | ${rules.length} rules |\n`;
      text += `| **Status** | Inactive (activate via monitoring) |\n`;

      if (risk_management) {
        text += `\n### Risk Management\n`;
        if (risk_management.max_position_pct) text += `- Max position: ${risk_management.max_position_pct}% of equity\n`;
        if (risk_management.stop_loss_pct) text += `- Stop loss: ${risk_management.stop_loss_pct}%\n`;
        if (risk_management.take_profit_pct) text += `- Take profit: ${risk_management.take_profit_pct}%\n`;
        if (risk_management.max_daily_trades) text += `- Max daily trades: ${risk_management.max_daily_trades}\n`;
      }

      text += `\n> Next: Use **alpaca_backtest** to test this strategy, or **alpaca_start_monitor** to activate it.`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_list_strategies",
    "List all saved strategies",
    {},
    async () => {
      const strategies = listStrategies();
      if (strategies.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No strategies saved yet. Use **alpaca_list_strategy_templates** for inspiration or **alpaca_create_strategy** to create one.",
            },
          ],
        };
      }

      let table = `## 📋 Saved Strategies (${strategies.length})\n\n`;
      table += "| Name | Universe | Rules | Active | Updated |\n";
      table += "|------|----------|-------|--------|--------|\n";

      for (const s of strategies) {
        table += `| **${s.name}** (\`${s.id.slice(0, 8)}\`) | ${s.universe.join(", ")} | ${s.rules.length} | ${s.is_active ? "✅" : "⬜"} | ${s.updated_at.split("T")[0]} |\n`;
      }

      return { content: [{ type: "text", text: table }] };
    }
  );

  server.tool(
    "alpaca_get_strategy",
    "Get detailed information about a specific strategy",
    { strategy_id: z.string().describe("Strategy ID") },
    async ({ strategy_id }) => {
      const strategy = getStrategy(strategy_id);
      if (!strategy) {
        return { content: [{ type: "text", text: `Strategy not found: ${strategy_id}` }], isError: true };
      }

      let text = `## 📊 Strategy: ${strategy.name}\n\n`;
      text += `**ID**: \`${strategy.id}\`\n`;
      text += `**Description**: ${strategy.description}\n`;
      text += `**Universe**: ${strategy.universe.join(", ")}\n`;
      text += `**Active**: ${strategy.is_active ? "Yes" : "No"}\n\n`;

      text += `### Rules\n\n`;
      for (let i = 0; i < strategy.rules.length; i++) {
        const rule = strategy.rules[i];
        text += `**Rule ${i + 1}** (${rule.trigger}${rule.schedule ? ` @ ${rule.schedule}` : ""})\n`;
        text += `- Conditions: ${rule.conditions.map((c) => `${c.indicator} ${c.op} ${c.value ?? c.target}`).join(" AND ")}\n`;
        text += `- Actions: ${rule.actions.map((a) => `${a.type}${a.symbol ? ` ${a.symbol}` : ""} ${a.sizing || ""} ${a.value || ""}`).join(", ")}\n\n`;
      }

      if (strategy.risk_management) {
        text += `### Risk Management\n`;
        text += `\`\`\`json\n${JSON.stringify(strategy.risk_management, null, 2)}\n\`\`\`\n`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "alpaca_delete_strategy",
    "Delete a saved strategy",
    { strategy_id: z.string().describe("Strategy ID to delete") },
    async ({ strategy_id }) => {
      const deleted = deleteStrategy(strategy_id);
      if (!deleted) {
        return { content: [{ type: "text", text: `Strategy not found: ${strategy_id}` }], isError: true };
      }
      return { content: [{ type: "text", text: `✅ Strategy \`${strategy_id}\` deleted.` }] };
    }
  );
}
