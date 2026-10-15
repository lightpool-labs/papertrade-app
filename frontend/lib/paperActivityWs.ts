import { INDEXER_WS_URL } from "@/lib/markWs";
import type { PaperActivityItem } from "@/lib/api";

type Handlers = {
  onEvent: (item: PaperActivityItem) => void;
  onError?: (error: Error) => void;
};

/** Subscribe indexer `paper.activity` (close loss / liqd / stake / unstake). */
export function subscribePaperActivity(handlers: Handlers): () => void {
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
          channel: "paper.activity",
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          error?: string;
          activity?: PaperActivityItem;
        };
        if (msg.type === "error") {
          handlers.onError?.(new Error(msg.error ?? "paper.activity ws error"));
          return;
        }
        if (msg.type === "subscribed" || msg.type === "unsubscribed") return;
        if (msg.type === "paper_activity" && msg.activity) {
          handlers.onEvent(msg.activity);
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
            channel: "paper.activity",
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
