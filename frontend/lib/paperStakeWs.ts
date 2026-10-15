import { INDEXER_WS_URL } from "@/lib/markWs";
import type { PaperStake } from "@/lib/api";

export type PaperStakeLive = {
  type?: string;
  market?: string;
  ts_ms?: number;
  staking_revenue?: string;
  staking_revenue_raw?: number;
  total_paper_supply?: string;
  total_paper_supply_raw?: number;
  total_staking_reward?: string;
  total_staking_reward_raw?: number;
  stake?: PaperStake;
  error?: string;
};

type Handlers = {
  onStake: (stake: PaperStake, tick: PaperStakeLive, tsMs: number) => void;
  onTick?: (tick: PaperStakeLive) => void;
  onError?: (error: Error) => void;
};

/**
 * Subscribe indexer `paper.stake` (market + user).
 * Snapshot on subscribe; live pushes include full `stake` (house-style).
 */
export function subscribePaperStake(
  market: string,
  userAddress: string,
  handlers: Handlers,
): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryMs = 500;
  let timer: number | null = null;
  const mkt = market.trim();
  const user = userAddress.trim();

  const connect = () => {
    if (closed || !mkt || !user) return;
    ws = new WebSocket(INDEXER_WS_URL);
    ws.onopen = () => {
      retryMs = 500;
      ws?.send(
        JSON.stringify({
          op: "subscribe",
          channel: "paper.stake",
          market: mkt,
          user_address: user,
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as PaperStakeLive;
        if (msg.type === "error") {
          handlers.onError?.(new Error(msg.error ?? "paper.stake ws error"));
          return;
        }
        if (msg.type === "subscribed" || msg.type === "unsubscribed") return;
        if (msg.type !== "paper_stake") return;
        handlers.onTick?.(msg);
        if (msg.stake) {
          const ts =
            typeof msg.ts_ms === "number" && msg.ts_ms > 0
              ? msg.ts_ms
              : Date.now();
          handlers.onStake(msg.stake, msg, ts);
        }
      } catch (err) {
        handlers.onError?.(
          err instanceof Error ? err : new Error("paper.stake decode failed"),
        );
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
            channel: "paper.stake",
            market: mkt,
            user_address: user,
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
