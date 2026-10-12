"use client";

import { useState, type CSSProperties } from "react";
import type { Market, PaperAccount } from "@/lib/api";
import { openPaper } from "@/lib/api";
import { AccountStrip } from "@/components/AccountStrip";
import { bustPrice, formatPrice, formatUsd } from "@/lib/math";

type Props = {
  market: Market | null;
  mark: number | null;
  account?: PaperAccount | null;
  accountLoading?: boolean;
  openPnl?: number | null;
  onOpened?: () => void | Promise<void>;
};

const LEVERAGE_PRESETS = [5, 10, 50, 100, 1000];
const MARGIN_PCTS = [10, 25, 50, 100];

export function PaperTicket({
  market,
  mark,
  account = null,
  accountLoading = false,
  openPnl = null,
  onOpened,
}: Props) {
  const [isLong, setIsLong] = useState(true);
  const [margin, setMargin] = useState("100");
  const [leverage, setLeverage] = useState(100);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const maxLev = market?.max_leverage ?? 1000;
  const bufferPpm = market?.liq_buffer_ppm ?? 500;

  const marginNum = Number(margin);
  const notional =
    Number.isFinite(marginNum) && marginNum > 0 ? marginNum * leverage : 0;
  const bust =
    mark !== null && mark > 0
      ? bustPrice(mark, leverage, isLong, bufferPpm)
      : 0;

  async function onOpen() {
    setStatus(null);
    if (!market?.paper_market) {
      setStatus(
        "Set paper_market in data/markets.json after create (P5 admin / localnet)",
      );
      return;
    }
    if (!Number.isFinite(marginNum) || marginNum <= 0) {
      setStatus("Enter a positive margin");
      return;
    }
    if (mark == null || mark <= 0) {
      setStatus("Waiting for mark price…");
      return;
    }

    setBusy(true);
    try {
      const result = await openPaper({
        market: market.paper_market,
        instrument: market.id,
        is_long: isLong,
        margin: marginNum,
        leverage,
      });
      const pos =
        result.position != null ? ` #${result.position}` : "";
      setStatus(
        `Opened${isLong ? " long" : " short"}${pos} · block ${result.block_num}`,
      );
      await onOpened?.();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Open failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="paper-ticket">
      <div className="ticket-body">
        <div className="side-toggle">
          <button
            type="button"
            className={`side-btn long${isLong ? " active" : ""}`}
            onClick={() => setIsLong(true)}
            disabled={busy}
          >
            Long
          </button>
          <button
            type="button"
            className={`side-btn short${!isLong ? " active" : ""}`}
            onClick={() => setIsLong(false)}
            disabled={busy}
          >
            Short
          </button>
        </div>

        <label className="field">
          <span>Margin (USDC)</span>
          <input
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            inputMode="decimal"
            disabled={busy}
          />
        </label>

        <div className="pct-row">
          {MARGIN_PCTS.map((pct) => (
            <button
              key={pct}
              type="button"
              className="chip-btn"
              disabled={busy}
              onClick={() => setMargin(String(Math.max(1, pct)))}
            >
              {pct === 100 ? "MAX" : `${pct}%`}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Leverage · {leverage}x</span>
          <input
            type="range"
            min={1}
            max={maxLev}
            value={leverage}
            disabled={busy}
            style={
              {
                ["--slider-pct"]: `${((leverage - 1) / Math.max(1, maxLev - 1)) * 100}%`,
              } as CSSProperties
            }
            onChange={(e) => setLeverage(Number(e.target.value))}
          />
        </label>

        <div className="pct-row">
          {LEVERAGE_PRESETS.filter((x) => x <= maxLev).map((lev) => (
            <button
              key={lev}
              type="button"
              className={`chip-btn${leverage === lev ? " active" : ""}`}
              disabled={busy}
              onClick={() => setLeverage(lev)}
            >
              {lev}x
            </button>
          ))}
        </div>

        <div className="ticket-stats">
          <div>
            <span>Order value</span>
            <strong>${formatUsd(notional)}</strong>
          </div>
          <div>
            <span>Bust price</span>
            <strong>{bust > 0 ? `$${formatPrice(bust)}` : "—"}</strong>
          </div>
          <div>
            <span>Mark</span>
            <strong>{mark !== null ? `$${formatPrice(mark)}` : "—"}</strong>
          </div>
        </div>

        <button
          type="button"
          className="open-btn"
          disabled={busy}
          onClick={() => void onOpen()}
        >
          {busy
            ? "Submitting…"
            : isLong
              ? "Open Long"
              : "Open Short"}
        </button>

        <AccountStrip
          account={account}
          loading={accountLoading}
          variant="ticket"
          openPnl={openPnl}
        />

        {status ? <p className="ticket-status">{status}</p> : null}
      </div>
    </aside>
  );
}
