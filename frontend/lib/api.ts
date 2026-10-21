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

export type MarkHistoryTick = {
  t: number;
  mark_price: string;
  oracle_price: string;
  mark_price_raw: number;
  oracle_price_raw: number;
  round: number;
  block_num: number;
};

export type MarkHistoryResponse = {
  spot_market: string;
  ticks: MarkHistoryTick[];
};

/** Indexed oracle/mark ticks (seed for tick chart). */
export async function getMarkHistory(
  slug: string,
  opts?: { fromMs?: number; limit?: number },
): Promise<MarkHistoryResponse> {
  const q = new URLSearchParams();
  if (opts?.fromMs != null) q.set("from_ms", String(opts.fromMs));
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  const res = await fetch(
    `${API_URL}/markets/${encodeURIComponent(slug)}/mark/history${qs ? `?${qs}` : ""}`,
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

export type PaperInstrumentExposure = {
  instrument: number;
  name: string;
  long: string;
  long_raw: number;
  short: string;
  short_raw: number;
  net: string;
  net_raw: number;
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
  buyback_cash?: string;
  buyback_cash_raw?: number;
  queue_nonempty: boolean;
  open_interest: string;
  open_interest_raw: number;
  open_margin: string;
  open_margin_raw: number;
  open_positions: number;
  instruments: PaperInstrumentExposure[];
  lp_balance: string;
  lp_balance_raw: number;
  open_house_pnl: string;
  open_house_pnl_raw: number;
  queue_debt: string;
  queue_debt_raw: number;
  queue_debt_positions?: number;
  queue_largest?: string;
  queue_largest_raw?: number;
  queue_paid_next?: string;
  queue_paid_next_raw?: number;
  queue_paid_next_user?: string;
  house_funds: string;
  house_funds_raw: number;
  volume: string;
  volume_raw: number;
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

export type PaperOiHistoryTick = {
  t: number;
  long: string;
  short: string;
  long_raw: number;
  short_raw: number;
};

export type PaperOiHistoryResponse = {
  market: string;
  instrument: number;
  name: string;
  ticks: PaperOiHistoryTick[];
};

export async function getHouseOiHistory(
  market: string,
  opts?: { instrument?: number; fromMs?: number; limit?: number },
): Promise<PaperOiHistoryResponse> {
  const q = new URLSearchParams();
  q.set("market", market.trim());
  if (opts?.instrument != null) q.set("instrument", String(opts.instrument));
  if (opts?.fromMs != null) q.set("from_ms", String(opts.fromMs));
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const res = await fetch(`${API_URL}/house/oi/history?${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type PaperHouseHistoryTick = {
  t: number;
  house_funds: string;
  house_funds_raw: number;
  lp_balance: string;
  lp_balance_raw: number;
  open_house_pnl: string;
  open_house_pnl_raw: number;
  queue_debt: string;
  queue_debt_raw: number;
};

export type PaperHouseHistoryResponse = {
  market: string;
  ticks: PaperHouseHistoryTick[];
};

export async function getHouseHistory(
  market: string,
  opts?: { fromMs?: number; limit?: number },
): Promise<PaperHouseHistoryResponse> {
  const q = new URLSearchParams();
  q.set("market", market.trim());
  if (opts?.fromMs != null) q.set("from_ms", String(opts.fromMs));
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const res = await fetch(`${API_URL}/house/history?${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type PaperDebtHistoryTick = {
  t: number;
  debt: string;
  debt_raw: number;
};

export type PaperDebtHistoryResponse = {
  market: string;
  ticks: PaperDebtHistoryTick[];
};

export async function getHouseDebtHistory(
  market: string,
  opts?: { fromMs?: number; limit?: number },
): Promise<PaperDebtHistoryResponse> {
  const q = new URLSearchParams();
  q.set("market", market.trim());
  if (opts?.fromMs != null) q.set("from_ms", String(opts.fromMs));
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const res = await fetch(`${API_URL}/house/queue/history?${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type PaperQueuePlacement = {
  market: string;
  address: string;
  ahead: string;
  ahead_raw: number;
  yours: string;
  yours_raw: number;
  behind: string;
  behind_raw: number;
  your_entries: number;
  in_queue: boolean;
};

export async function getHouseQueuePlacement(
  market: string,
  owner: string,
): Promise<PaperQueuePlacement> {
  const q = new URLSearchParams();
  q.set("market", market.trim());
  q.set("owner", owner.trim());
  const res = await fetch(`${API_URL}/house/queue/placement?${q}`);
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { placement: PaperQueuePlacement };
  return body.placement;
}

export type PaperStake = {
  market: string;
  address: string;
  paper_token: string;
  paper: string;
  paper_raw: number;
  staked: string;
  staked_raw: number;
  claimable: string;
  claimable_raw: number;
  pending_reward: string;
  pending_reward_raw: number;
  reward_pool: string;
  reward_pool_raw: number;
  buyback_cash?: string;
  buyback_cash_raw?: number;
  total_staked: string;
  total_staked_raw: number;
  stake_share_pct: string;
  rewards_claimed: string;
  rewards_claimed_raw: number;
  total_staker_rewards: string;
  total_staker_rewards_raw: number;
  reward_rate: string;
  mint_rate: string;
  mint_rate_raw: number;
  tracked_lp: string;
  tracked_lp_raw: number;
  tail_hwm: string;
  tail_hwm_raw: number;
  flat_threshold: string;
  flat_threshold_raw: number;
  flat_rate_ppm: number;
  tail_decay_scale: string;
  tail_decay_scale_raw: number;
  reward_token: string;
  total_supply: string;
  total_supply_raw: number;
  staked_supply: string;
  staked_supply_raw: number;
  stake_ratio_pct: string;
  staking_contract: string;
};

export type PaperActivityItem = {
  kind: string;
  market: string;
  user: string;
  amount: string;
  amount_raw: number;
  pnl?: string;
  pnl_raw?: number;
  position?: number;
  block_num: number;
  ts_ms: number;
};

export type PaperStakeHistoryTick = {
  t: number;
  staking_revenue: string;
  staking_revenue_raw: number;
  total_paper_supply: string;
  total_paper_supply_raw: number;
  total_staking_reward: string;
  total_staking_reward_raw: number;
};

export async function getPaperStakeHistory(
  market: string,
  opts?: { fromMs?: number; limit?: number },
): Promise<PaperStakeHistoryTick[]> {
  const q = new URLSearchParams();
  q.set("market", market.trim());
  if (opts?.fromMs != null) q.set("from_ms", String(opts.fromMs));
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const res = await fetch(`${API_URL}/paper/stake/history?${q}`);
  if (!res.ok) {
    const message = await parseError(res);
    throw new Error(
      `${message} (restart indexer with paper routes: /api/paper/stake/history)`,
    );
  }
  const body = (await res.json()) as { ticks: PaperStakeHistoryTick[] };
  return body.ticks ?? [];
}

export async function getPaperActivity(
  market?: string,
  limit?: number,
): Promise<PaperActivityItem[]> {
  const q = new URLSearchParams();
  if (market?.trim()) q.set("market", market.trim());
  if (limit != null) q.set("limit", String(limit));
  const qs = q.toString();
  const res = await fetch(`${API_URL}/paper/activity${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const message = await parseError(res);
    throw new Error(
      `${message} (restart indexer with paper routes: /api/paper/activity)`,
    );
  }
  const body = (await res.json()) as { activities: PaperActivityItem[] };
  return body.activities ?? [];
}

export async function getPaper(
  address: string,
  market?: string,
): Promise<PaperStake> {
  const q = new URLSearchParams();
  q.set("address", address.trim());
  if (market?.trim()) q.set("market", market.trim());
  const res = await fetch(`${API_URL}/paper?${q}`);
  if (!res.ok) {
    const message = await parseError(res);
    throw new Error(
      `${message} (restart indexer with paper routes: /api/paper/stake)`,
    );
  }
  const body = (await res.json()) as { stake: PaperStake };
  return body.stake;
}

