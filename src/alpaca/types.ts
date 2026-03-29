// Alpaca API v2 type definitions

export type TradingMode = "paper" | "live";

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  mode: TradingMode;
}

export interface Account {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  initial_margin: string;
  maintenance_margin: string;
  daytrade_count: number;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  created_at: string;
}

export interface Position {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  side: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
export type TimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";
export type OrderStatus =
  | "new"
  | "partially_filled"
  | "filled"
  | "done_for_day"
  | "canceled"
  | "expired"
  | "replaced"
  | "pending_cancel"
  | "pending_replace"
  | "accepted"
  | "pending_new"
  | "accepted_for_bidding"
  | "stopped"
  | "rejected"
  | "suspended"
  | "calculated";

export interface OrderRequest {
  symbol: string;
  qty?: string;
  notional?: string;
  side: OrderSide;
  type: OrderType;
  time_in_force: TimeInForce;
  limit_price?: string;
  stop_price?: string;
  trail_price?: string;
  trail_percent?: string;
  extended_hours?: boolean;
  client_order_id?: string;
  order_class?: "simple" | "bracket" | "oco" | "oto";
  take_profit?: { limit_price: string };
  stop_loss?: { stop_price: string; limit_price?: string };
}

export interface Order {
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: OrderType;
  side: OrderSide;
  time_in_force: TimeInForce;
  limit_price: string | null;
  stop_price: string | null;
  status: OrderStatus;
  extended_hours: boolean;
  trail_percent: string | null;
  trail_price: string | null;
}

export interface Quote {
  t: string; // timestamp
  ax: string; // ask exchange
  ap: number; // ask price
  as: number; // ask size
  bx: string; // bid exchange
  bp: number; // bid price
  bs: number; // bid size
  c: string[]; // conditions
  z: string; // tape
}

export interface Bar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  n: number; // number of trades
  vw: number; // volume weighted average price
}

export interface Snapshot {
  latestTrade: {
    t: string;
    p: number;
    s: number;
    c: string[];
    i: number;
    z: string;
  };
  latestQuote: Quote;
  minuteBar: Bar;
  dailyBar: Bar;
  prevDailyBar: Bar;
}

export type Timeframe = "1Min" | "5Min" | "15Min" | "30Min" | "1Hour" | "4Hour" | "1Day" | "1Week" | "1Month";

export interface BarsRequest {
  symbol: string;
  timeframe: Timeframe;
  start?: string;
  end?: string;
  limit?: number;
  feed?: "iex" | "sip";
}

export interface Clock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

// Strategy types
export interface StrategyCondition {
  indicator: string;
  params?: Record<string, number | string>;
  op: "gt" | "lt" | "gte" | "lte" | "eq" | "cross_above" | "cross_below";
  value?: number;
  target?: string;
}

export interface StrategyAction {
  type: "buy" | "sell" | "notify";
  symbol?: string;
  sizing?: "shares" | "percent_of_equity" | "notional" | "all";
  value?: number;
  message?: string;
}

export interface StrategyRule {
  trigger: "cron" | "alert" | "manual";
  schedule?: string;
  conditions: StrategyCondition[];
  actions: StrategyAction[];
}

export interface RiskManagement {
  max_position_pct?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  max_daily_trades?: number;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  universe: string[];
  rules: StrategyRule[];
  risk_management?: RiskManagement;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Alert types
export interface AlertRule {
  id: string;
  symbol: string;
  condition: {
    indicator: string;
    op: string;
    value: number;
  };
  action: {
    type: "notify" | "trade";
    params?: Record<string, unknown>;
  };
  is_active: boolean;
  last_triggered_at: string | null;
  created_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  symbol: string;
  message: string;
  data: Record<string, unknown>;
  acknowledged: boolean;
  created_at: string;
}

// Backtest types
export interface BacktestConfig {
  strategy_id: string;
  symbols: string[];
  start_date: string;
  end_date: string;
  initial_capital: number;
}

export interface BacktestTrade {
  date: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  value: number;
  reason: string;
}

export interface BacktestMetrics {
  total_return_pct: number;
  annualized_return_pct: number;
  sharpe_ratio: number;
  max_drawdown_pct: number;
  win_rate_pct: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  profit_factor: number;
  calmar_ratio: number;
  volatility_pct: number;
}

export interface BacktestResult {
  id: string;
  strategy_id: string;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equity_curve: Array<{ date: string; equity: number }>;
  created_at: string;
}
