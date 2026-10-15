/** Mirror of lightpool-x paper::math (PPM = 1e6). */
const PPM = 1_000_000;

export type ImpactCurve = {
  deadbandPpm: number;
  winFeePpm: number;
  baseRatePpm: number;
  rateMultiplier: number;
  positionMultiplierPpm: number;
  /** Human USDC dollars (e.g. 100_000). */
  referenceNotional: number;
  quoteDecimals?: number;
};

/** Papertrade BTC launch curve (bootstrap / DESIGN). */
export const DEFAULT_BTC_IMPACT: ImpactCurve = {
  deadbandPpm: 20,
  winFeePpm: 20_000,
  baseRatePpm: 100_000,
  rateMultiplier: 15_000,
  positionMultiplierPpm: 814_598_000,
  referenceNotional: 100_000,
  quoteDecimals: 6,
};

export function bustPrice(
  entry: number,
  leverage: number,
  isLong: boolean,
  bufferPpm: number,
): number {
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  const lev = Math.max(1, Math.floor(leverage));
  const levAdj = PPM / lev;
  const buffer = bufferPpm;
  if (isLong) {
    return (entry * (PPM - levAdj + buffer)) / PPM;
  }
  return (entry * (PPM + levAdj - buffer)) / PPM;
}

export function formatUsd(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact Y-axis labels for house charts (`$1.2K`, `$3.5M`). */
export function formatAxisUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const a = Math.abs(value);
  if (a >= 1_000_000) {
    const n = a / 1_000_000;
    return `${sign}$${n >= 10 ? n.toFixed(0) : n.toFixed(1)}M`;
  }
  if (a >= 1_000) {
    const n = a / 1_000;
    return `${sign}$${n >= 10 ? n.toFixed(0) : n.toFixed(1)}K`;
  }
  if (a >= 10) return `${sign}$${a.toFixed(0)}`;
  if (a === 0) return "$0";
  return `${sign}$${a.toFixed(2)}`;
}

/** Format indexer token amount strings (`1000000`, `-12.5`) as `1,000,000.00`. */
export function formatAmount(raw: string | number | null | undefined): string {
  if (raw == null || raw === "") return "—";
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  return formatUsd(n);
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return formatUsd(value, 2);
  if (value >= 1) return formatUsd(value, 4);
  return formatUsd(value, 6);
}

export function formatMoney(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const abs = formatUsd(Math.abs(value), digits);
  if (value < 0) return `-$${abs}`;
  if (value > 0) return `+$${abs}`;
  return `$${abs}`;
}

function impactScalePpm(movePpm: number, curve: ImpactCurve): number {
  if (!(movePpm > 0)) return 0;
  const s = PPM;
  const term1 = (s * s) / (movePpm * curve.rateMultiplier);
  const scale = Math.pow(10, curve.quoteDecimals ?? 6);
  const refRaw = curve.referenceNotional * scale;
  const term2 = (refRaw * s) / (movePpm * curve.positionMultiplierPpm);
  const denom = s + term1 + term2;
  if (!(denom > 0)) return 0;
  return ((s - curve.baseRatePpm) * s) / denom;
}

/**
 * Estimated settle PnL (DESIGN close): raw → deadband → impact scale → win fee.
 * Losses stay raw (same as event_pnl). Mark stands in for exit while open.
 */
export function unrealizedPnl(
  entry: number,
  mark: number,
  notional: number,
  isLong: boolean,
  curve: ImpactCurve = DEFAULT_BTC_IMPACT,
): number | null {
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(mark) ||
    mark <= 0 ||
    !Number.isFinite(notional) ||
    notional <= 0
  ) {
    return null;
  }
  const delta = isLong ? mark - entry : entry - mark;
  const raw = (notional * delta) / entry;
  if (!(raw > 0)) return raw;

  const band = (notional * curve.deadbandPpm) / PPM;
  const gainDb = Math.max(0, raw - band);
  if (gainDb <= 0) return 0;

  const entryBand = (entry * curve.deadbandPpm) / PPM;
  const exitAdj = isLong ? mark - entryBand : mark + entryBand;
  const movePpm = (Math.abs(exitAdj - entry) * PPM) / entry;
  const scale = impactScalePpm(movePpm, curve);
  const gainScaled = (gainDb * scale) / PPM;
  const fee = (gainScaled * curve.winFeePpm) / PPM;
  return gainScaled - fee;
}

export function parseAmount(raw: string | number | null | undefined): number {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw;
  return Number(String(raw).replace(/,/g, ""));
}

export type PnlPositionLike = {
  entry_price: string;
  notional: string;
  is_long: boolean;
  instrument?: number;
};

/** Sum settle-estimated unrealized PnL for open rows (optionally filtered by instrument). */
export function sumUnrealizedPnl(
  positions: PnlPositionLike[],
  mark: number | null | undefined,
  instrumentId?: number | null,
  curve: ImpactCurve = DEFAULT_BTC_IMPACT,
): number | null {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  let total = 0;
  let any = false;
  for (const row of positions) {
    if (instrumentId != null && row.instrument != null && row.instrument !== instrumentId) {
      continue;
    }
    const pnl = unrealizedPnl(
      parseAmount(row.entry_price),
      mark,
      parseAmount(row.notional),
      row.is_long,
      curve,
    );
    if (pnl == null) continue;
    total += pnl;
    any = true;
  }
  return any ? total : 0;
}
