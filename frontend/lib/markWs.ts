export type OracleTick = {
  type?: string;
  channel?: string;
  spot_market?: string;
  mark_price?: string;
  oracle_price?: string;
  mark_price_raw?: number;
  oracle_price_raw?: number;
  round?: number;
  block_num?: number;
  ts_ms?: number;
};

function defaultIndexerWsUrl(): string {
  if (process.env.NEXT_PUBLIC_INDEXER_WS_URL) {
    return process.env.NEXT_PUBLIC_INDEXER_WS_URL;
  }
  const http =
    process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://127.0.0.1:3002";
  const base = http.replace(/\/$/, "");
  if (base.startsWith("https://")) {
    return `${base.replace(/^https/, "wss")}/api/ws`;
  }
  return `${base.replace(/^http/, "ws")}/api/ws`;
}

export const INDEXER_WS_URL = defaultIndexerWsUrl();

type Handlers = {
  onTick: (tick: OracleTick) => void;
};

/** Subscribe indexer `oracle` channel (pushed on `oracle_committed`). */
export function subscribeOracleMark(
  spotMarket: string,
  handlers: Handlers,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let timer: number | null = null;
  const key = spotMarket.trim();

  const connect = () => {
    if (closed || !key) return;
    ws = new WebSocket(INDEXER_WS_URL);
    ws.onopen = () => {
      retryMs = 500;
      ws?.send(
        JSON.stringify({
          op: "subscribe",
          channel: "oracle",
          spot_market: key,
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as OracleTick & {
          type?: string;
          error?: string;
        };
        if (msg.type === "error" || msg.type === "subscribed") return;
        if (msg.type === "oracle" || msg.mark_price != null) {
          handlers.onTick(msg);
        }
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      if (closed) return;
      timer = window.setTimeout(() => {
        retryMs = Math.min(retryMs * 2, 8_000);
        connect();
      }, retryMs);
    };
    ws.onerror = () => {
      ws?.close();
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer != null) window.clearTimeout(timer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          op: "unsubscribe",
          channel: "oracle",
          spot_market: key,
        }),
      );
    }
    ws?.close();
    ws = null;
  };
}
