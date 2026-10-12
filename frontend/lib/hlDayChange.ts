import { HL_INFO_URL, hlCoinFromSymbol } from "@/lib/hlCandles";

export type HlDayContext = {
  coin: string;
  prevDayPx: number;
  markPx: number;
  /** (markPx - prevDayPx) / prevDayPx * 100 */
  changePct: number;
};

/**
 * Hyperliquid 24h change baseline (`prevDayPx`), same window exchanges /
 * papertrade use for the header % next to mark.
 */
export async function fetchHlDayContext(
  symbol: string,
): Promise<HlDayContext | null> {
  const coin = hlCoinFromSymbol(symbol);
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid metaAndAssetCtxs HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || body.length < 2) return null;
  const meta = body[0] as { universe?: { name?: string }[] };
  const ctxs = body[1] as Record<string, unknown>[];
  const universe = meta?.universe;
  if (!Array.isArray(universe) || !Array.isArray(ctxs)) return null;

  const idx = universe.findIndex(
    (u) => (u?.name ?? "").toUpperCase() === coin,
  );
  if (idx < 0 || !ctxs[idx]) return null;

  const prevDayPx = Number(ctxs[idx].prevDayPx);
  const markPx = Number(ctxs[idx].markPx ?? ctxs[idx].midPx);
  if (!Number.isFinite(prevDayPx) || prevDayPx <= 0) return null;
  if (!Number.isFinite(markPx) || markPx <= 0) return null;

  return {
    coin,
    prevDayPx,
    markPx,
    changePct: ((markPx - prevDayPx) / prevDayPx) * 100,
  };
}

/** 24h % vs HL prevDayPx using our live mark when available. */
export function changePctVsPrevDay(
  liveMark: number | null,
  prevDayPx: number | null,
): number | null {
  if (prevDayPx == null || prevDayPx <= 0) return null;
  if (liveMark == null || !Number.isFinite(liveMark) || liveMark <= 0) {
    return null;
  }
  return ((liveMark - prevDayPx) / prevDayPx) * 100;
}
