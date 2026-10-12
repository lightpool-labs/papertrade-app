export const HL_WS_URL =
  process.env.NEXT_PUBLIC_HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws";

export const HL_INFO_URL =
  process.env.NEXT_PUBLIC_HYPERLIQUID_INFO_URL ??
  "https://api.hyperliquid.xyz/info";

export type ChartInterval = "1m" | "5m" | "1h" | "1d";

export const CHART_INTERVALS: ChartInterval[] = ["1m", "5m", "1h", "1d"];

export type HlBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const INTERVAL_MS: Record<ChartInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/** Hyperliquid coin for main perps is bare `BTC` / `ETH` (matches papertrade). */
export function hlCoinFromSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  const bare = trimmed
    .replace(/^xyz:/i, "")
    .split("/")[0]
    ?.trim()
    .toUpperCase();
  return bare || trimmed.toUpperCase();
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function parseCandle(row: unknown): HlBar | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const tMs = num(o.t);
  const open = num(o.o);
  const high = num(o.h);
  const low = num(o.l);
  const close = num(o.c);
  const volume = num(o.v ?? 0);
  if (
    !Number.isFinite(tMs) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }
  return {
    time: Math.floor(tMs / 1000),
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
  };
}

/** HTTP candleSnapshot — browser talks to Hyperliquid directly. */
export async function fetchHlCandleSnapshot(
  coin: string,
  interval: ChartInterval,
  limit = 300,
): Promise<HlBar[]> {
  const endMs = Date.now();
  const startMs = endMs - limit * INTERVAL_MS[interval];
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin,
        interval,
        startTime: startMs,
        endTime: endMs,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid candleSnapshot HTTP ${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  const bars: HlBar[] = [];
  for (const row of raw) {
    const bar = parseCandle(row);
    if (bar) bars.push(bar);
  }
  bars.sort((a, b) => a.time - b.time);
  const dedup: HlBar[] = [];
  for (const bar of bars) {
    if (dedup.length && dedup[dedup.length - 1].time === bar.time) {
      dedup[dedup.length - 1] = bar;
    } else {
      dedup.push(bar);
    }
  }
  return dedup;
}

type CandleHandlers = {
  onBar: (bar: HlBar) => void;
  onStatus?: (connected: boolean) => void;
};

/** Browser → Hyperliquid candle WS (not via BFF). */
export function subscribeHlCandles(
  coin: string,
  interval: ChartInterval,
  handlers: CandleHandlers,
): () => void {
  const normalized = coin.trim();
  if (!normalized || typeof window === "undefined") {
    return () => undefined;
  }

  let closed = false;
  let ws: WebSocket | null = null;
  let retryTimer: number | null = null;
  let attempt = 0;

  const clearRetry = () => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearRetry();
    const delay = Math.min(8_000, 500 * 2 ** attempt);
    attempt += 1;
    retryTimer = window.setTimeout(connect, delay);
  };

  const connect = () => {
    if (closed) return;
    clearRetry();
    ws = new WebSocket(HL_WS_URL);
    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus?.(true);
      ws?.send(
        JSON.stringify({
          method: "subscribe",
          subscription: {
            type: "candle",
            coin: normalized,
            interval,
          },
        }),
      );
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          channel?: string;
          data?: unknown;
        };
        if (msg.channel !== "candle" || msg.data == null) return;
        const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const row of rows) {
          const bar = parseCandle(row);
          if (bar) handlers.onBar(bar);
        }
      } catch {
        // ignore malformed
      }
    };
    ws.onerror = () => {
      ws?.close();
    };
    ws.onclose = () => {
      handlers.onStatus?.(false);
      ws = null;
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    closed = true;
    clearRetry();
    handlers.onStatus?.(false);
    if (ws) {
      ws.onclose = null;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              method: "unsubscribe",
              subscription: {
                type: "candle",
                coin: normalized,
                interval,
              },
            }),
          );
        }
      } catch {
        // ignore
      }
      ws.close();
      ws = null;
    }
  };
}
