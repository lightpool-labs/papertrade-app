"use client";

import { useMemo, useState } from "react";
import type {
  Market,
  PaperAccount,
  PaperPositionHistory,
  PaperPositionOpen,
} from "@/lib/api";
import { closePaper } from "@/lib/api";
import { AccountStrip } from "@/components/AccountStrip";
import {
  formatMoney,
  formatPrice,
  formatUsd,
  parseAmount,
  unrealizedPnl,
} from "@/lib/math";

type Tab = "status" | "positions" | "history";

type Props = {
  markets: Market[];
  open: PaperPositionOpen[];
  history: PaperPositionHistory[];
  loading?: boolean;
  error?: string | null;
  /** When set, filter open rows to this instrument id (Trade page). */
  instrumentId?: number | null;
  /** Live mark for the selected instrument (Trade page). */
  mark?: number | null;
  account?: PaperAccount | null;
  openPnl?: number | null;
  onClosed?: (row: PaperPositionOpen) => void | Promise<void>;
};

function instrumentName(markets: Market[], id: number): string {
  return markets.find((m) => m.id === id)?.name ?? `#${id}`;
}

function pnlClass(value: number | null): string {
  if (value == null || value === 0) return "";
  return value > 0 ? "pnl-win" : "pnl-loss";
}

export function PositionsPanel({
  markets,
  open,
  history,
  loading,
  error,
  instrumentId,
  mark = null,
  account = null,
  openPnl = null,
  onClosed,
}: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const openRows = useMemo(() => {
    if (instrumentId == null) return open;
    return open.filter((r) => r.instrument === instrumentId);
  }, [open, instrumentId]);

  async function onClose(row: PaperPositionOpen) {
    const key = `${row.market}:${row.position}`;
    setCloseError(null);
    setClosingId(key);
    try {
      await closePaper({ market: row.market, position: row.position });
      setClosingId(null);
      await onClosed?.(row);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Close failed");
      setClosingId(null);
    }
  }

  return (
    <section className="bottom-panel">
      <div className="bottom-tabs">
        <button
          type="button"
          className={`tab${tab === "status" ? " active" : ""}`}
          onClick={() => setTab("status")}
        >
          Status
        </button>
        <button
          type="button"
          className={`tab${tab === "positions" ? " active" : ""}`}
          onClick={() => setTab("positions")}
        >
          Positions
        </button>
        <button
          type="button"
          className={`tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {error ? <div className="banner error">{error}</div> : null}
      {closeError ? <div className="banner error">{closeError}</div> : null}

      {tab === "status" ? (
        <div className="equity-tab-body">
          <AccountStrip
            account={account}
            loading={loading}
            variant="panel"
            openPnl={openPnl}
          />
        </div>
      ) : tab === "positions" ? (
        loading && openRows.length === 0 ? (
          <div className="bottom-empty">Loading positions…</div>
        ) : openRows.length === 0 ? (
          <div className="bottom-empty">No open positions</div>
        ) : (
          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Side</th>
                  <th>Margin</th>
                  <th>Notional</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>uPnL</th>
                  <th>ROE</th>
                  <th>Bust</th>
                  <th>Pos #</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {openRows.map((row) => {
                  const entry = parseAmount(row.entry_price);
                  const notional = parseAmount(row.notional);
                  const margin = parseAmount(row.margin);
                  const rowKey = `${row.market}:${row.position}`;
                  const pnl = unrealizedPnl(
                    entry,
                    mark ?? NaN,
                    notional,
                    row.is_long,
                  );
                  const roe =
                    pnl != null && Number.isFinite(margin) && margin > 0
                      ? (pnl / margin) * 100
                      : null;
                  const busy = closingId === rowKey;
                  return (
                    <tr key={rowKey}>
                      <td>{instrumentName(markets, row.instrument)}</td>
                      <td className={row.is_long ? "side-long" : "side-short"}>
                        {row.is_long ? "Long" : "Short"}
                      </td>
                      <td>
                        {Number.isFinite(margin)
                          ? `$${formatUsd(margin)}`
                          : row.margin}
                      </td>
                      <td>
                        {Number.isFinite(notional)
                          ? `$${formatUsd(notional)}`
                          : row.notional}
                      </td>
                      <td>
                        {Number.isFinite(entry)
                          ? `$${formatPrice(entry)}`
                          : row.entry_price}
                      </td>
                      <td>
                        {mark != null && mark > 0
                          ? `$${formatPrice(mark)}`
                          : "—"}
                      </td>
                      <td className={pnlClass(pnl)}>
                        {pnl == null ? "—" : formatMoney(pnl)}
                      </td>
                      <td className={pnlClass(roe)}>
                        {roe == null
                          ? "—"
                          : `${roe >= 0 ? "+" : ""}${roe.toFixed(2)}%`}
                      </td>
                      <td>
                        {Number.isFinite(parseAmount(row.bust_price))
                          ? `$${formatPrice(parseAmount(row.bust_price))}`
                          : row.bust_price}
                      </td>
                      <td>{row.position}</td>
                      <td>
                        <button
                          type="button"
                          className="open-btn pos-close-btn"
                          disabled={busy}
                          onClick={() => void onClose(row)}
                        >
                          {busy ? "Closing…" : "Close"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : loading && history.length === 0 ? (
        <div className="bottom-empty">Loading history…</div>
      ) : history.length === 0 ? (
        <div className="bottom-empty">No history yet</div>
      ) : (
        <div className="pos-table-wrap">
          <table className="pos-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Side</th>
                <th>Kind</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>Fee</th>
                <th>Minted</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => {
                const pnl = parseAmount(row.pnl);
                return (
                  <tr key={`${row.market}:${row.position}:${row.closed_block}`}>
                    <td>{instrumentName(markets, row.instrument)}</td>
                    <td className={row.is_long ? "side-long" : "side-short"}>
                      {row.is_long ? "Long" : "Short"}
                    </td>
                    <td>{row.kind}</td>
                    <td>{row.entry_price}</td>
                    <td>{row.exit_price}</td>
                    <td className={pnlClass(Number.isFinite(pnl) ? pnl : null)}>
                      {Number.isFinite(pnl) ? formatMoney(pnl) : row.pnl}
                    </td>
                    <td>{row.fee}</td>
                    <td>{row.minted}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
