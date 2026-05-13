# Alpaca US Stock Trading Skill

Professional US stock trading skill for [OpenClaw](https://github.com/openclaw/openclaw) powered by [Alpaca Markets](https://alpaca.markets/).

## Features

| Module | Capabilities |
|--------|-------------|
| **Account Setup** | Guided Alpaca registration, API key configuration, paper/live mode |
| **Market Data** | Real-time quotes, historical bars, multi-stock snapshots, market overview, stock screener |
| **Trading** | Market/limit/stop/trailing orders, position management, order history |
| **Strategy** | Custom strategy DSL, built-in templates (SMA crossover, DCA, mean reversion, momentum) |
| **Monitoring** | WebSocket real-time prices, cron-based position tracking, configurable alert rules |
| **Backtesting** | Historical strategy testing, Sharpe/drawdown/win-rate metrics, equity curve |
| **Analytics** | Portfolio performance, trade journal, review sessions with AI-ready data |
| **Gateway Cron** | Stable `alpaca_cron_tick` entrypoint for OpenClaw/TalentHub scheduled wakeups |
| **High Precision** | Fractional share and crypto-friendly quantities up to 9 decimals, prices up to 8 decimals |

## Quick Start

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Alpaca API keys
```

Or configure interactively through the agent using `alpaca_configure`.

### 3. Use with OpenClaw

Copy or symlink this folder into your OpenClaw workspace skills directory:

```bash
ln -s /path/to/alpaca-us-stock-skill ~/.openclaw/skills/alpaca-us-stock
```

### 4. Use as standalone MCP Server

```bash
# Via stdio (for MCP clients)
node dist/index.js

# For development
npm run dev
```

#### Claude Code configuration

Add to your MCP settings:

```json
{
  "mcpServers": {
    "alpaca-us-stock": {
      "command": "node",
      "args": ["/path/to/alpaca-us-stock-skill/dist/index.js"],
      "env": {
        "ALPACA_API_KEY": "your-key",
        "ALPACA_API_SECRET": "your-secret",
        "ALPACA_MODE": "paper"
      }
    }
  }
}
```

## MCP Tools (25 tools)

### Setup & Account
- `alpaca_setup_guide` — Step-by-step registration guide
- `alpaca_configure` — Configure API keys and trading mode
- `alpaca_get_account` — Account info, balance, market status

### Market Data
- `alpaca_get_quote` — Real-time stock quote
- `alpaca_get_bars` — Historical candlestick data
- `alpaca_get_snapshot` — Multi-stock comparison
- `alpaca_market_overview` — US market indices overview
- `alpaca_screen_stocks` — Filter stocks by criteria

### Trading
- `alpaca_place_order` — Place buy/sell orders
- `alpaca_get_orders` — List orders
- `alpaca_cancel_order` — Cancel specific order
- `alpaca_cancel_all_orders` — Cancel all open orders
- `alpaca_get_positions` — View current positions
- `alpaca_close_position` — Close a position
- `alpaca_close_all_positions` — Liquidate all positions

### Strategy
- `alpaca_list_strategy_templates` — Browse built-in strategies
- `alpaca_create_strategy` — Create custom strategy
- `alpaca_list_strategies` — List saved strategies
- `alpaca_get_strategy` — Strategy details
- `alpaca_delete_strategy` — Delete strategy

### Monitoring
- `alpaca_start_monitor` — Start background monitoring daemon
- `alpaca_cron_tick` — Gateway cron entrypoint for high-frequency reminders, risk checks, and briefings
- `alpaca_stop_monitor` — Stop monitoring
- `alpaca_get_monitor_status` — Check status and unread alerts
- `alpaca_add_alert` — Add price alert rule
- `alpaca_remove_alert` — Remove alert rule
- `alpaca_get_alerts` — List all alert rules

### Backtesting
- `alpaca_backtest` — Run historical backtest
- `alpaca_get_backtest_results` — Retrieve past backtest

### Analytics
- `alpaca_get_performance` — Portfolio performance report
- `alpaca_get_trade_journal` — Trade history with notes
- `alpaca_add_trade_note` — Add journal entry to a trade
- `alpaca_review_session` — Comprehensive trading review

## Architecture

```
SKILL.md (OpenClaw agent instructions)
    ↓ agent reads skill, uses MCP tools
MCP Server (src/index.ts, stdio transport)
    ├── Tools Layer (src/tools/*.ts)
    ├── Alpaca Client (src/alpaca/client.ts)
    ├── Strategy Engine (src/strategy/)
    ├── Backtest Engine (src/backtest/)
    ├── Monitor Daemon (scripts/monitor-daemon.ts)
    │   ├── WebSocket price stream
    │   ├── Cron scheduler
    │   └── Alert engine
    └── SQLite Storage (src/storage/)
```

## Strategy DSL Example

```json
{
  "name": "SPY Momentum",
  "universe": ["SPY"],
  "rules": [
    {
      "trigger": "cron",
      "schedule": "0 31 9 * * 1-5",
      "conditions": [
        { "indicator": "sma", "params": { "period": 50 }, "op": "cross_above", "target": "sma_200" }
      ],
      "actions": [
        { "type": "buy", "symbol": "$symbol", "sizing": "percent_of_equity", "value": 90 }
      ]
    }
  ],
  "risk_management": {
    "stop_loss_pct": 8,
    "take_profit_pct": 25
  }
}
```

## Tech Stack

- TypeScript + Node.js
- MCP SDK (`@modelcontextprotocol/sdk`)
- Alpaca API v2 (REST + WebSocket)
- better-sqlite3 (local storage)
- node-cron (scheduling)
- ws (WebSocket client)

## License

MIT
