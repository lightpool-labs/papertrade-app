export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001/api";

export type Market = {
  paper_market: string;
  quote_decimals: number;
  liq_buffer_ppm: number;
  id: number;
  slug: string;
  name: string;
  hl_symbol: string;
  price_market: string;
  max_leverage: number;
  min_margin: number;
  retired: boolean;
};

export type MarkResponse = {
  slug: string;
  symbol: string;
  hl_coin: string;
  mark: string;
  source: string;
};

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // ignore
  }
  return `HTTP ${res.status}`;
}

export async function getHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getReady(): Promise<{ status: string; indexer: boolean }> {
  const res = await fetch(`${API_URL}/ready`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function listMarkets(): Promise<Market[]> {
  const res = await fetch(`${API_URL}/markets`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { markets: Market[] };
  return body.markets;
}

export async function getMarket(slug: string): Promise<Market> {
  const res = await fetch(`${API_URL}/markets/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getMark(slug: string): Promise<MarkResponse> {
  const res = await fetch(
    `${API_URL}/markets/${encodeURIComponent(slug)}/mark`,
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type PaperAccount = {
  market: string;
  address: string;
  available: string;
  queued: string;
  available_raw: number;
  queued_raw: number;
  entry_head: number;
  entry_tail: number;
  queued_truncated: boolean;
  margin_in_use: string;
  margin_in_use_raw: number;
  open_pnl: string;
  open_pnl_raw: number;
  equity: string;
  equity_raw: number;
  open_positions: number;
};

export type PaperPositionOpen = {
  market: string;
  position: number;
  owner: string;
  instrument: number;
  is_long: boolean;
  margin: string;
  notional: string;
  entry_price: string;
  bust_price: string;
  funded_from_queued: boolean;
  opened_block: number;
};

export type PaperPositionHistory = {
  market: string;
  position: number;
  owner: string;
  instrument: number;
  is_long: boolean;
  margin: string;
  notional: string;
  entry_price: string;
  bust_price: string;
  exit_price: string;
  pnl: string;
  fee: string;
  payout: string;
  queued: string;
  minted: string;
  kind: "closed" | "liquidated";
  liquidator?: string;
  opened_block: number;
  closed_block: number;
};

export async function getAccount(
  address: string,
  market?: string,
): Promise<PaperAccount> {
  const qs = new URLSearchParams({ address });
  if (market?.trim()) qs.set("market", market.trim());
  const res = await fetch(`${API_URL}/account?${qs}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { account: PaperAccount };
  return body.account;
}

export async function listPositions(
  address: string,
  opts?: { market?: string; status?: "open" | "closed" | "all" },
): Promise<{
  open: PaperPositionOpen[];
  history: PaperPositionHistory[];
  total: number;
}> {
  const qs = new URLSearchParams({ address });
  if (opts?.market?.trim()) qs.set("market", opts.market.trim());
  if (opts?.status) qs.set("status", opts.status);
  const res = await fetch(`${API_URL}/positions?${qs}`);
  if (!res.ok) {
    const message = await parseError(res);
    if (res.status === 404) {
      throw new Error(
        `${message} (restart indexer with paper routes: /api/paper/positions)`,
      );
    }
    throw new Error(message);
  }
  return res.json();
}

export async function listHistory(
  address: string,
  market?: string,
): Promise<{ history: PaperPositionHistory[]; total: number }> {
  const qs = new URLSearchParams({ address });
  if (market?.trim()) qs.set("market", market.trim());
  const res = await fetch(`${API_URL}/history?${qs}`);
  if (!res.ok) {
    const message = await parseError(res);
    if (res.status === 404) {
      throw new Error(
        `${message} (restart indexer with paper routes: /api/paper/history)`,
      );
    }
    throw new Error(message);
  }
  return res.json();
}

export type OpenPaperRequest = {
  market: string;
  instrument: number;
  is_long: boolean;
  margin: number;
  leverage: number;
  fund_from_queued?: boolean;
};

export type OpenPaperResponse = {
  digest: string;
  block_num: number;
  status: string;
  position: number | null;
  owner: string;
};

export type PaperHouse = {
  market: string;
  free_cash: string;
  free_cash_raw: number;
  side_bucket: string;
  side_bucket_raw: number;
  tracked_lp: string;
  tracked_lp_raw: number;
  tail_hwm: string;
  tail_hwm_raw: number;
  queue_head: number;
  queue_tail: number;
  total_queued: string;
  total_queued_raw: number;
  staker_fee_acc: string;
  staker_fee_acc_raw: number;
  dev_fee_acc: string;
  dev_fee_acc_raw: number;
  queue_nonempty: boolean;
};

export async function getHouse(market?: string): Promise<PaperHouse> {
  const qs = new URLSearchParams();
  if (market?.trim()) qs.set("market", market.trim());
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await fetch(`${API_URL}/house${suffix}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { house: PaperHouse };
  return body.house;
}

export async function openPaper(
  body: OpenPaperRequest,
): Promise<OpenPaperResponse> {
  const res = await fetch(`${API_URL}/paper/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type ClosePaperRequest = {
  market: string;
  position: number;
};

export type ClosePaperResponse = {
  digest: string;
  block_num: number;
  status: string;
  position: number;
  owner: string;
};

export async function closePaper(
  body: ClosePaperRequest,
): Promise<ClosePaperResponse> {
  const res = await fetch(`${API_URL}/paper/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
