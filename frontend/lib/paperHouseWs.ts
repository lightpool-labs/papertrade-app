import { INDEXER_WS_URL } from "@/lib/markWs";
import type { PaperHouse } from "@/lib/api";

export type PaperHouseWsEvent = {
  type?: string;
  market?: string;
  ts_ms?: number;
  house?: PaperHouse;
  error?: string;
};

type Handlers = {
  onHouse: (house: PaperHouse, tsMs: number) => void;
  onError?: (error: Error) => void;
};

/** Subscribe indexer `paper.house` (snapshot on subscribe + per-block coalesced pushes). */
export function subscribePaperHouse(
  market: string,
  handlers: Handlers,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let timer: number | null = null;
  const key = market.trim();

  const connect = () => {
    if (closed || !key) return;
    ws = new WebSocket(INDEXER_WS_URL);
    ws.onopen = () => {
      retryMs = 500;
      ws?.send(
        JSON.stringify({
          op: "subscribe",
          channel: "paper.house",
          market: key,
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as PaperHouseWsEvent;
        if (msg.type === "error") {
          handlers.onError?.(new Error(msg.error || "paper.house ws error"));
          return;
        }
        if (msg.type === "subscribed" || msg.type === "unsubscribed") return;
        if (msg.type !== "paper_house" || !msg.house) return;
        const ts =
          typeof msg.ts_ms === "number" && msg.ts_ms > 0
            ? msg.ts_ms
            : Date.now();
        handlers.onHouse(msg.house, ts);
      } catch (err) {
        handlers.onError?.(
          err instanceof Error ? err : new Error("paper.house decode failed"),
        );
      }
    };
    ws.onerror = () => {
      handlers.onError?.(new Error("paper.house ws error"));
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      timer = window.setTimeout(() => {
        retryMs = Math.min(retryMs * 2, 8_000);
        connect();
      }, retryMs);
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
            channel: "paper.house",
            market: key,
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
