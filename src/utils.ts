import { AlpacaClient } from "./alpaca/client.js";
import { getConfig } from "./storage/db.js";
import type { TradingMode } from "./alpaca/types.js";

let _client: AlpacaClient | null = null;

export function getClient(): AlpacaClient {
  // Check env vars first, then DB config
  const apiKey = process.env.ALPACA_API_KEY || getConfig("alpaca_api_key");
  const apiSecret = process.env.ALPACA_API_SECRET || getConfig("alpaca_api_secret");
  const mode = (process.env.ALPACA_MODE || getConfig("alpaca_mode") || "paper") as TradingMode;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "Alpaca API not configured. Use the alpaca_configure tool or set ALPACA_API_KEY and ALPACA_API_SECRET environment variables."
    );
  }

  // Recreate if config changed
  if (_client) {
    return _client;
  }

  _client = new AlpacaClient({ apiKey, apiSecret, mode });
  return _client;
}

export function resetClient(): void {
  _client = null;
}

export function formatMode(): string {
  const mode = process.env.ALPACA_MODE || getConfig("alpaca_mode") || "paper";
  return mode === "live" ? "⚠️ [LIVE]" : "📝 [PAPER]";
}
