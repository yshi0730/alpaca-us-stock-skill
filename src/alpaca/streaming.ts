import WebSocket from "ws";
import type { TradingMode } from "./types.js";

const WS_URLS = {
  paper: "wss://stream.data.alpaca.markets/v2/iex",
  live: "wss://stream.data.alpaca.markets/v2/sip",
} as const;

export type StreamEvent =
  | { type: "trade"; symbol: string; price: number; size: number; timestamp: string }
  | { type: "quote"; symbol: string; bidPrice: number; askPrice: number; timestamp: string }
  | { type: "bar"; symbol: string; open: number; high: number; low: number; close: number; volume: number; timestamp: string }
  | { type: "error"; message: string }
  | { type: "connected" }
  | { type: "disconnected" };

export class AlpacaStream {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private apiSecret: string;
  private mode: TradingMode;
  private subscribedSymbols: Set<string> = new Set();
  private listeners: Array<(event: StreamEvent) => void> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(apiKey: string, apiSecret: string, mode: TradingMode) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.mode = mode;
  }

  on(listener: (event: StreamEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;

    const url = WS_URLS[this.mode];
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.ws!.send(
        JSON.stringify({ action: "auth", key: this.apiKey, secret: this.apiSecret })
      );
    });

    this.ws.on("message", (data) => {
      try {
        const messages = JSON.parse(data.toString()) as Array<Record<string, unknown>>;
        for (const msg of messages) {
          this.handleMessage(msg);
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on("close", () => {
      this.ws = null;
      this.emit({ type: "disconnected" });
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", () => {
      this.ws?.close();
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.T as string;

    if (type === "success" && msg.msg === "authenticated") {
      this.emit({ type: "connected" });
      if (this.subscribedSymbols.size > 0) {
        this.sendSubscribe([...this.subscribedSymbols]);
      }
      return;
    }

    if (type === "error") {
      this.emit({ type: "error", message: String(msg.msg) });
      return;
    }

    if (type === "t") {
      this.emit({
        type: "trade",
        symbol: msg.S as string,
        price: msg.p as number,
        size: msg.s as number,
        timestamp: msg.t as string,
      });
    } else if (type === "q") {
      this.emit({
        type: "quote",
        symbol: msg.S as string,
        bidPrice: msg.bp as number,
        askPrice: msg.ap as number,
        timestamp: msg.t as string,
      });
    } else if (type === "b") {
      this.emit({
        type: "bar",
        symbol: msg.S as string,
        open: msg.o as number,
        high: msg.h as number,
        low: msg.l as number,
        close: msg.c as number,
        volume: msg.v as number,
        timestamp: msg.t as string,
      });
    }
  }

  subscribe(symbols: string[]): void {
    for (const s of symbols) this.subscribedSymbols.add(s.toUpperCase());
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(symbols);
    }
  }

  unsubscribe(symbols: string[]): void {
    for (const s of symbols) this.subscribedSymbols.delete(s.toUpperCase());
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          action: "unsubscribe",
          trades: symbols.map((s) => s.toUpperCase()),
          quotes: symbols.map((s) => s.toUpperCase()),
          bars: symbols.map((s) => s.toUpperCase()),
        })
      );
    }
  }

  private sendSubscribe(symbols: string[]): void {
    const upper = symbols.map((s) => s.toUpperCase());
    this.ws!.send(
      JSON.stringify({
        action: "subscribe",
        trades: upper,
        quotes: upper,
        bars: upper,
      })
    );
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get symbols(): string[] {
    return [...this.subscribedSymbols];
  }
}
