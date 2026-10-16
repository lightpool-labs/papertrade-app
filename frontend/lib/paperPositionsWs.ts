import { INDEXER_WS_URL } from "@/lib/markWs";

export type PaperPositionEvent = {
  type?: string;
  event?: string;
  user_address?: string;
  market?: string;
  position?: number;
  block_num?: number;
  instrument?: number;
  is_long?: boolean;
  bust_price_raw?: number;
  notional?: string;
  notional_raw?: number;
  margin?: string;
  margin_raw?: number;
  entry_price?: string;
  entry_price_raw?: number;
  instrument_name?: string;
  pnl?: string;
  pnl_raw?: number;
};

type Handlers = {
  onEvent: (event: PaperPositionEvent) => void;
  onError?: (error: Error) => void;
};

/** Subscribe indexer `paper.positions` (all opens / closes / liquidations). */
export function subscribePaperPositions(handlers: Handlers): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let timer: number | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(INDEXER_WS_URL);
    ws.onopen = () => {
      retryMs = 500;
      ws?.send(
        JSON.stringify({
          op: "subscribe",
          channel: "paper.positions",
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as PaperPositionEvent & {
          error?: string;
        };
        if (msg.type === "error") {
          handlers.onError?.(new Error(msg.error ?? "paper.positions ws error"));
          return;
        }
        if (msg.type === "subscribed" || msg.type === "unsubscribed") return;
        if (msg.type === "paper_position" || msg.event != null) {
          handlers.onEvent(msg);
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
      try {
        ws.send(
          JSON.stringify({
            op: "unsubscribe",
            channel: "paper.positions",
          }),
        );
      } catch {
        // ignore
      }
    }
    ws?.close();
    ws = null;
  };
}
