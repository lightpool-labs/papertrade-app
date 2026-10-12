export const HL_WS_URL =
  process.env.NEXT_PUBLIC_HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws";

export type HlTradeTick = {
  coin: string;
  px: number;
  sz: number;
  side: string;
  time: number;
};

type TradeListener = (tick: HlTradeTick) => void;

/** Browser → Hyperliquid trades WS (display price only; not via BFF). */
export function subscribeHlTrades(
  coin: string,
  onTrade: TradeListener,
): () => void {
  const normalized = coin.trim().toUpperCase();
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
      ws?.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "trades", coin: normalized },
        }),
      );
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          channel?: string;
          data?: unknown;
        };
        if (msg.channel !== "trades" || msg.data == null) return;
        const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
        for (const row of rows) {
          const tick = parseTrade(row);
          if (tick && tick.coin.toUpperCase() === normalized) {
            onTrade(tick);
          }
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onerror = () => {
      ws?.close();
    };
    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    closed = true;
    clearRetry();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}

function parseTrade(row: unknown): HlTradeTick | null {
  if (!row || typeof row !== "object") return null;
  const obj = row as Record<string, unknown>;
  const coin = typeof obj.coin === "string" ? obj.coin : "";
  const px = Number(obj.px);
  const sz = Number(obj.sz ?? 0);
  const side = typeof obj.side === "string" ? obj.side : "";
  const time = Number(obj.time ?? 0);
  if (!coin || !Number.isFinite(px) || px <= 0) return null;
  return { coin, px, sz, side, time };
}
