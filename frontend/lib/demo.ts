import type { PaperAccount, PaperPositionHistory, PaperPositionOpen } from "@/lib/api";

export const DEMO_API = (process.env.NEXT_PUBLIC_DEMO_API ?? "").replace(
  /\/$/,
  "",
);

export type DemoSession = {
  session_id: string;
  symbol: string;
  duration: number;
  climax_at: number;
  sample_hz: number;
  seed?: number;
  song_url: string;
  timeline_url: string;
};

export type DemoMark = { t: number; px: number };

export type DemoEventKind = "open" | "close" | "liq";

export type DemoEvent = {
  t: number;
  id: string;
  kind: DemoEventKind;
  asset: string;
  side: "long" | "short";
  /** Margin for open/close, loss for liq. */
  amount_usd: number;
  /** Realized pnl, closes only. */
  pnl_usd?: number;
};

export type DemoTimeline = {
  symbol: string;
  duration: number;
  climax_at: number;
  sample_hz: number;
  marks: DemoMark[];
  events: DemoEvent[];
};

/** Window CustomEvent carrying a demo activity chip to the banner. */
export const DEMO_EVENT = "lp-demo-event";

/** Shaped like a real PaperPositionEvent for HouseActivityBanner. */
export type DemoChip = {
  event: "opened" | "closed" | "liquidated";
  instrument_name: string;
  is_long: boolean;
  margin_raw: number;
  pnl_raw?: number;
  user_address: string;
  demo_id: string;
};

export function demoConfigured(): boolean {
  return DEMO_API.length > 0;
}

export function demoUrl(path: string): string {
  return `${DEMO_API}${path}`;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // ignore
  }
  return `HTTP ${res.status}`;
}

export async function fetchDemoSession(id: string): Promise<DemoSession> {
  const res = await fetch(demoUrl(`/api/demo/sessions/${encodeURIComponent(id)}`));
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

type LegacyLiq = {
  t: number;
  id: string;
  asset: string;
  loss_usd: number;
  side: "long" | "short";
};

export async function fetchDemoTimeline(id: string): Promise<DemoTimeline> {
  const res = await fetch(
    demoUrl(`/api/demo/sessions/${encodeURIComponent(id)}/timeline`),
  );
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as DemoTimeline & { liqs?: LegacyLiq[] };
  if (!Array.isArray(body.events)) {
    if (Array.isArray(body.liqs)) {
      body.events = body.liqs.map((liq) => ({
        t: liq.t,
        id: liq.id,
        kind: "liq" as const,
        asset: liq.asset,
        side: liq.side,
        amount_usd: liq.loss_usd,
      }));
    } else {
      throw new Error("timeline has no events (re-upload the song)");
    }
  }
  return body;
}

export function emitDemoChip(chip: DemoChip): void {
  window.dispatchEvent(new CustomEvent(DEMO_EVENT, { detail: chip }));
}

const DEMO_OWNER = "0xdemo000000000000000000000000000000000001";
const DEMO_AVAILABLE = 100_000;
const DEMO_LONG_LEVERAGE = 10;

/** Fractions vs the song anchor. Bust levels sit inside the climax dump. */
const DEMO_LONGS: { position: number; margin: number; entryOff: number; bustOff: number }[] = [
  { position: 1, margin: 500, entryOff: 0.002, bustOff: -0.08 },
  { position: 2, margin: 2_000, entryOff: 0.004, bustOff: -0.16 },
  { position: 3, margin: 8_000, entryOff: 0.006, bustOff: -0.24 },
];

export function buildDemoLongs(anchor: number, owner: string | null): PaperPositionOpen[] {
  const who = owner?.trim() || DEMO_OWNER;
  return DEMO_LONGS.map((row) => {
    const entry = anchor * (1 + row.entryOff);
    const bust = anchor * (1 + row.bustOff);
    return {
      market: "demo",
      position: row.position,
      owner: who,
      instrument: 0,
      is_long: true,
      margin: row.margin.toFixed(2),
      notional: (row.margin * DEMO_LONG_LEVERAGE).toFixed(2),
      entry_price: entry.toFixed(1),
      bust_price: bust.toFixed(1),
      funded_from_queued: false,
      opened_block: 1,
    };
  });
}

export function demoAccount(
  owner: string | null,
  marginInUse: number,
): PaperAccount {
  const available = DEMO_AVAILABLE;
  const margin = Math.max(0, marginInUse);
  const equity = available + margin;
  const who = owner?.trim() || DEMO_OWNER;
  return {
    market: "demo",
    address: who,
    available: available.toFixed(2),
    queued: "0.00",
    available_raw: available * 1_000_000,
    queued_raw: 0,
    entry_head: 0,
    entry_tail: 0,
    queued_truncated: false,
    margin_in_use: margin.toFixed(2),
    margin_in_use_raw: margin * 1_000_000,
    open_pnl: "0.00",
    open_pnl_raw: 0,
    equity: equity.toFixed(2),
    equity_raw: equity * 1_000_000,
    open_positions: 0,
  };
}

export function demoLiqHistory(row: PaperPositionOpen): PaperPositionHistory {
  const margin = Number(row.margin);
  return {
    market: row.market,
    position: row.position,
    owner: row.owner,
    instrument: row.instrument,
    is_long: row.is_long,
    margin: row.margin,
    notional: row.notional,
    entry_price: row.entry_price,
    bust_price: row.bust_price,
    exit_price: row.bust_price,
    pnl: (-margin).toFixed(2),
    fee: "0",
    payout: "0",
    queued: "0",
    minted: "0",
    kind: "liquidated",
    opened_block: row.opened_block,
    closed_block: row.opened_block + 1,
  };
}
