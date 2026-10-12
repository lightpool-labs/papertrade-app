import { INDEXER_WS_URL } from "@/lib/markWs";

export type PaperUserEvent = {
  type?: string;
  event?: string;
  user_address?: string;
  market?: string;
  position?: number;
  block_num?: number;
};

type Handlers = {
  onEvent: (event: PaperUserEvent) => void;
  onError?: (error: Error) => void;
};

/**
 * Subscribe indexer `paper.user` channel (pushed on paper open/close/liqd index).
 * Same WS endpoint pattern as stocks `user` / paper `oracle`.
 */
export function subscribePaperUser(
  userAddress: string,
  handlers: Handlers,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let timer: number | null = null;
  const key = userAddress.trim();

  const connect = () => {
    if (closed || !key) return;
    ws = new WebSocket(INDEXER_WS_URL);
    ws.onopen = () => {
      retryMs = 500;
      ws?.send(
        JSON.stringify({
          op: "subscribe",
          channel: "paper.user",
          user_address: key,
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as PaperUserEvent & {
          type?: string;
          error?: string;
        };
        if (msg.type === "error") {
          handlers.onError?.(new Error(msg.error ?? "paper.user ws error"));
          return;
        }
        if (msg.type === "subscribed" || msg.type === "unsubscribed") return;
        if (msg.type === "paper_user" || msg.event != null) {
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
            channel: "paper.user",
            user_address: key,
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
