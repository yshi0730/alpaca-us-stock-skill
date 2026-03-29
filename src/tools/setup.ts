import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig, setConfig } from "../storage/db.js";
import { AlpacaClient } from "../alpaca/client.js";

export function registerSetupTools(server: McpServer): void {
  server.tool(
    "alpaca_setup_guide",
    "Get step-by-step guide for Alpaca account setup and API key configuration",
    { step: z.number().optional().describe("Specific step number (1-5) to show, omit for overview") },
    async ({ step }) => {
      const steps: Record<number, string> = {
        1: `## Step 1: Create an Alpaca Account

1. Go to **https://app.alpaca.markets/signup**
2. Sign up with your email address
3. Complete identity verification (SSN, address, employment info)
4. Wait for approval (usually takes 1-3 business days)

> 💡 Alpaca offers **paper trading** immediately after sign-up, no approval needed for that!`,

        2: `## Step 2: Get Your API Keys

1. Log into **https://app.alpaca.markets/**
2. Click on your profile icon (top right) → **API Keys**
3. For **Paper Trading**: Switch to "Paper Trading" view and generate keys
4. For **Live Trading**: Generate keys from the "Live Trading" view
5. **Save both** your API Key ID and Secret Key — the secret is only shown once!

> ⚠️ Never share your API keys with anyone. Treat them like passwords.`,

        3: `## Step 3: Configure Your API Keys

Tell me your API Key and Secret, and I'll save them securely. Use the **alpaca_configure** tool with:
- \`api_key\`: Your Alpaca API Key ID
- \`api_secret\`: Your Alpaca API Secret Key
- \`mode\`: "paper" (recommended to start) or "live"

> 🔒 Keys are stored locally in an encrypted SQLite database on your machine.`,

        4: `## Step 4: Verify Your Setup

Once configured, I'll run **alpaca_get_account** to verify:
- ✅ API keys are valid
- ✅ Account status is ACTIVE
- ✅ Trading is not blocked
- ✅ Check your buying power and cash balance`,

        5: `## Step 5: Start Trading!

You're all set! Here's what you can do:
- 📊 **Check market data**: Ask me about any stock (quotes, charts, market overview)
- 💰 **Place trades**: Buy/sell stocks with various order types
- 📋 **Create strategies**: Define automated trading strategies
- 🔔 **Set up monitoring**: Real-time alerts and position tracking
- 📈 **Backtest**: Test strategies against historical data
- 📝 **Review**: Track performance and review your trades

> 💡 I recommend starting with **paper trading** to get familiar with the system before using real money.`,
      };

      if (step && steps[step]) {
        return { content: [{ type: "text", text: steps[step] }] };
      }

      const overview = `# 🇺🇸 Alpaca US Stock Trading — Setup Guide

## Quick Start (5 Steps)

| Step | Action | Status |
|------|--------|--------|
| 1 | Create Alpaca Account | ${getConfig("alpaca_api_key") ? "✅" : "⬜"} |
| 2 | Get API Keys | ${getConfig("alpaca_api_key") ? "✅" : "⬜"} |
| 3 | Configure API Keys | ${getConfig("alpaca_api_key") ? "✅" : "⬜"} |
| 4 | Verify Setup | ${getConfig("alpaca_verified") === "true" ? "✅" : "⬜"} |
| 5 | Start Trading! | ⬜ |

Ask me for details on any step, e.g. "Show me step 2".

---
**Current config**: ${getConfig("alpaca_api_key") ? `Mode = ${getConfig("alpaca_mode") || "paper"}, API Key = ${getConfig("alpaca_api_key")?.slice(0, 6)}...` : "Not configured yet"}`;

      return { content: [{ type: "text", text: overview }] };
    }
  );

  server.tool(
    "alpaca_configure",
    "Configure Alpaca API credentials and trading mode",
    {
      api_key: z.string().describe("Alpaca API Key ID"),
      api_secret: z.string().describe("Alpaca API Secret Key"),
      mode: z.enum(["paper", "live"]).default("paper").describe("Trading mode: paper (default) or live"),
    },
    async ({ api_key, api_secret, mode }) => {
      // Validate by making a test API call
      const client = new AlpacaClient({ apiKey: api_key, apiSecret: api_secret, mode });
      try {
        const account = await client.getAccount();

        // Save config
        setConfig("alpaca_api_key", api_key);
        setConfig("alpaca_api_secret", api_secret);
        setConfig("alpaca_mode", mode);
        setConfig("alpaca_verified", "true");

        const modeWarning =
          mode === "live"
            ? "\n\n⚠️ **WARNING: You are in LIVE trading mode. Real money will be used!**"
            : "\n\n✅ **Paper trading mode** — no real money at risk.";

        return {
          content: [
            {
              type: "text",
              text: `## ✅ Configuration Successful!

**Account**: ${account.account_number}
**Status**: ${account.status}
**Mode**: ${mode.toUpperCase()}
**Equity**: $${parseFloat(account.equity).toLocaleString()}
**Buying Power**: $${parseFloat(account.buying_power).toLocaleString()}
**Cash**: $${parseFloat(account.cash).toLocaleString()}${modeWarning}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `## ❌ Configuration Failed

Could not validate API keys. Error: ${err instanceof Error ? err.message : String(err)}

Please double-check:
1. API Key ID and Secret are correct
2. Keys match the selected mode (${mode})
3. Your Alpaca account is active

Use **alpaca_setup_guide** step 2 for key generation instructions.`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
