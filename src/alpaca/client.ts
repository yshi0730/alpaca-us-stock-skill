import type {
  Account,
  AlpacaConfig,
  Bar,
  BarsRequest,
  Clock,
  Order,
  OrderRequest,
  Position,
  Quote,
  Snapshot,
  TradingMode,
} from "./types.js";

const BASE_URLS = {
  paper: {
    trading: "https://paper-api.alpaca.markets",
    data: "https://data.alpaca.markets",
  },
  live: {
    trading: "https://api.alpaca.markets",
    data: "https://data.alpaca.markets",
  },
} as const;

export class AlpacaClient {
  private apiKey: string;
  private apiSecret: string;
  private mode: TradingMode;

  constructor(config: AlpacaConfig) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.mode = config.mode;
  }

  get tradingBaseUrl(): string {
    return BASE_URLS[this.mode].trading;
  }

  get dataBaseUrl(): string {
    return BASE_URLS[this.mode].data;
  }

  get isPaper(): boolean {
    return this.mode === "paper";
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.apiKey,
      "APCA-API-SECRET-KEY": this.apiSecret,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(baseUrl: string, path: string, options?: RequestInit): Promise<T> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...this.headers(), ...options?.headers },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca API error ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private trading<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request(this.tradingBaseUrl, path, options);
  }

  private data<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request(this.dataBaseUrl, path, options);
  }

  // ── Account ──

  async getAccount(): Promise<Account> {
    return this.trading("/v2/account");
  }

  async getClock(): Promise<Clock> {
    return this.trading("/v2/clock");
  }

  // ── Orders ──

  async placeOrder(order: OrderRequest): Promise<Order> {
    return this.trading("/v2/orders", {
      method: "POST",
      body: JSON.stringify(order),
    });
  }

  async getOrders(params?: {
    status?: string;
    limit?: number;
    symbols?: string;
    after?: string;
    until?: string;
    direction?: "asc" | "desc";
  }): Promise<Order[]> {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    const query = qs.toString();
    return this.trading(`/v2/orders${query ? `?${query}` : ""}`);
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.trading(`/v2/orders/${orderId}`);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(this.tradingBaseUrl, `/v2/orders/${orderId}`, {
      method: "DELETE",
    }).catch(() => {
      // DELETE returns 204 no content
    });
  }

  async cancelAllOrders(): Promise<void> {
    await this.request(this.tradingBaseUrl, "/v2/orders", {
      method: "DELETE",
    }).catch(() => {});
  }

  // ── Positions ──

  async getPositions(): Promise<Position[]> {
    return this.trading("/v2/positions");
  }

  async getPosition(symbol: string): Promise<Position> {
    return this.trading(`/v2/positions/${symbol}`);
  }

  async closePosition(symbol: string, qty?: string): Promise<Order> {
    const qs = qty ? `?qty=${qty}` : "";
    return this.request(this.tradingBaseUrl, `/v2/positions/${symbol}${qs}`, {
      method: "DELETE",
    });
  }

  async closeAllPositions(): Promise<void> {
    await this.request(this.tradingBaseUrl, "/v2/positions", {
      method: "DELETE",
    }).catch(() => {});
  }

  // ── Market Data ──

  async getQuote(symbol: string): Promise<Quote> {
    const res = await this.data<{ quote: Quote }>(
      `/v2/stocks/${symbol}/quotes/latest?feed=iex`
    );
    return res.quote;
  }

  async getBars(params: BarsRequest): Promise<Bar[]> {
    const { symbol, timeframe, start, end, limit, feed } = params;
    const qs = new URLSearchParams({ timeframe });
    if (start) qs.set("start", start);
    if (end) qs.set("end", end);
    if (limit) qs.set("limit", String(limit));
    qs.set("feed", feed || "iex");

    const res = await this.data<{ bars: Bar[] }>(
      `/v2/stocks/${symbol}/bars?${qs}`
    );
    return res.bars;
  }

  async getSnapshot(symbol: string): Promise<Snapshot> {
    const res = await this.data<{ [key: string]: Snapshot }>(
      `/v2/stocks/snapshots?symbols=${symbol}&feed=iex`
    );
    return res[symbol];
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    return this.data<Record<string, Snapshot>>(
      `/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`
    );
  }

  async getLatestTrades(symbols: string[]): Promise<
    Record<string, { t: string; p: number; s: number }>
  > {
    const res = await this.data<{ trades: Record<string, { t: string; p: number; s: number }> }>(
      `/v2/stocks/trades/latest?symbols=${symbols.join(",")}&feed=iex`
    );
    return res.trades;
  }
}
