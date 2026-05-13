const DEFAULT_LOCALE = "en-US";

export function toFiniteNumber(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeDecimalString(value: string | number, maxDecimals = 9): string {
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.slice(0, maxDecimals).replace(/0+$/, "");
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

export function formatDecimal(value: string | number, options: {
  minDecimals?: number;
  maxDecimals?: number;
  locale?: string;
} = {}): string {
  const { minDecimals = 0, maxDecimals = 8, locale = DEFAULT_LOCALE } = options;
  const n = toFiniteNumber(value);
  return n.toLocaleString(locale, {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  });
}

export function formatMoney(value: string | number, maxDecimals = 8): string {
  const n = toFiniteNumber(value);
  const abs = Math.abs(n);
  const decimals = abs > 0 && abs < 1 ? maxDecimals : 2;
  return `${n < 0 ? "-" : ""}$${formatDecimal(abs, { minDecimals: 2, maxDecimals: decimals })}`;
}

export function formatQty(value: string | number): string {
  return formatDecimal(value, { minDecimals: 0, maxDecimals: 9 });
}

export function formatPct(value: string | number, maxDecimals = 4): string {
  const n = toFiniteNumber(value);
  return `${n >= 0 ? "+" : ""}${formatDecimal(n, { minDecimals: 2, maxDecimals })}%`;
}

export function truncateToStep(value: number, decimals = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
}
