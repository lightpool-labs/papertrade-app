import { API_URL, getAccount, type PaperAccount } from "@/lib/api";
import { parseAmount } from "@/lib/math";
import type { Eip712Payload } from "@/lib/wallet";

const CLOB_INDEX_URL =
  process.env.NEXT_PUBLIC_CLOB_INDEX_URL ?? "http://127.0.0.1:3002";

export type BridgeToken = {
  symbol: string;
  evm: string;
  lp: string;
  inbound: string;
};

export type BridgeConfig = {
  configured: boolean;
  evm_chain_id: number;
  evm_rpc: string;
  evm_bridge: string;
  tokens: BridgeToken[];
};

export type PreparedTx = {
  digest_hex: string;
  unsigned_tx_hex: string;
  eip712: Eip712Payload;
  auth_scheme?: string | null;
};

export type BalanceEntry = {
  token: string;
  symbol: string;
  total: string;
  locked: string;
  available: string;
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

export async function getBridge(): Promise<BridgeConfig> {
  const res = await fetch(`${API_URL}/bridge`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function prepareAgent(
  user: string,
  agent: string,
): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/agent/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, agent }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperOpen(body: {
  user: string;
  agent: string;
  market: string;
  instrument: number;
  is_long: boolean;
  margin: number;
  leverage: number;
  fund_from_queued?: boolean;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/open/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperClose(body: {
  user: string;
  agent: string;
  market: string;
  position: number;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/close/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperStake(body: {
  user: string;
  agent: string;
  market: string;
  amount: number;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/stake/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperUnstake(body: {
  user: string;
  agent: string;
  market: string;
  amount: number;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/unstake/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperClaim(body: {
  user: string;
  agent: string;
  market: string;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/claim/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperDeposit(body: {
  user: string;
  market: string;
  amount: string;
  agent?: string;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/deposit/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function preparePaperWithdraw(body: {
  user: string;
  market: string;
  amount: string;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/paper/withdraw/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function prepareBridgeWithdraw(body: {
  user: string;
  token: string;
  amount: string;
  inbound: string;
  foreign_recipient: string;
}): Promise<PreparedTx> {
  const res = await fetch(`${API_URL}/withdraw/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function submitSignedTx(
  unsignedTxHex: string,
  signature: string,
  authScheme = "eip712",
): Promise<{
  digest: string;
  status: string;
  block_num: number;
  position?: number | null;
}> {
  const res = await fetch(`${API_URL}/tx/sign/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      unsigned_tx_hex: unsignedTxHex,
      signature,
      auth_scheme: authScheme,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function fetchBalances(
  address: string,
  tokens: BridgeToken[],
): Promise<BalanceEntry[]> {
  if (tokens.length === 0) return [];
  const res = await fetch(
    `${CLOB_INDEX_URL}/api/accounts/${encodeURIComponent(address)}/balances`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokens: tokens.map((token) => ({
          symbol: token.symbol,
          address: token.lp,
        })),
      }),
    },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export function findUsdcToken(config: BridgeConfig): BridgeToken | null {
  return (
    config.tokens.find((t) => t.symbol.toUpperCase() === "USDC") ??
    config.tokens.find((t) => t.symbol.toUpperCase() === "USDT") ??
    config.tokens[0] ??
    null
  );
}

export function parseAvailableRaw(entry: BalanceEntry | undefined): number {
  if (!entry) return 0;
  const n = Number(entry.available);
  return Number.isFinite(n) ? n : 0;
}

/** Paper Available = shared LP USDC token balance (same as spot/event). */
export async function getAccountWithUsdcAvailable(
  address: string,
  market?: string,
): Promise<PaperAccount | null> {
  let paper: PaperAccount | null = null;
  if (market?.trim()) {
    try {
      paper = await getAccount(address, market);
    } catch {
      paper = null;
    }
  }

  let usdcHuman: number | null = null;
  try {
    const bridge = await getBridge();
    const usdc = bridge.configured ? findUsdcToken(bridge) : null;
    if (usdc) {
      const entries = await fetchBalances(address, [usdc]);
      // Indexer balances already return human amounts (format_token_amount).
      usdcHuman = parseAvailableRaw(entries[0]);
    }
  } catch {
    usdcHuman = null;
  }

  if (usdcHuman == null) return paper;
  if (!paper) {
    return {
      market: market?.trim() ?? "",
      address,
      available: String(usdcHuman),
      queued: "0",
      available_raw: Math.round(usdcHuman * 1e6),
      queued_raw: 0,
      entry_head: 0,
      entry_tail: 0,
      queued_truncated: false,
      margin_in_use: "0",
      margin_in_use_raw: 0,
      open_pnl: "0",
      open_pnl_raw: 0,
      equity: String(usdcHuman),
      equity_raw: Math.round(usdcHuman * 1e6),
      open_positions: 0,
    };
  }

  const queued = parseAmount(paper.queued);
  const margin = parseAmount(paper.margin_in_use);
  const openPnl = parseAmount(paper.open_pnl);
  const equity =
    usdcHuman +
    (Number.isFinite(queued) ? queued : 0) +
    (Number.isFinite(margin) ? margin : 0) +
    (Number.isFinite(openPnl) ? openPnl : 0);
  return {
    ...paper,
    available: String(usdcHuman),
    available_raw: Math.round(usdcHuman * 1e6),
    equity: String(equity),
    equity_raw: Math.round(equity * 1e6),
  };
}
