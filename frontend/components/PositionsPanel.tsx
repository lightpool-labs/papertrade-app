"use client";

import { memo, useCallback, useMemo, useState } from "react";
import type {
  Market,
  PaperAccount,
  PaperPositionHistory,
  PaperPositionOpen,
} from "@/lib/api";
import { useWallet } from "@/components/WalletProvider";
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

function posKey(market: string, position: number): string {
  return `${market.trim().toLowerCase()}:${position}`;
}

type OpenRowProps = {
  markets: Market[];
  row: PaperPositionOpen;
  mark: number | null;
  busy: boolean;
  onClose: (row: PaperPositionOpen) => void;
};

const OpenPositionRow = memo(function OpenPositionRow({
  markets,
  row,
  mark,
  busy,
  onClose,
}: OpenRowProps) {
  const entry = parseAmount(row.entry_price);
  const notional = parseAmount(row.notional);
  const margin = parseAmount(row.margin);
  const pnl = unrealizedPnl(entry, mark ?? NaN, notional, row.is_long);
  const roe =
    pnl != null && Number.isFinite(margin) && margin > 0
      ? (pnl / margin) * 100
      : null;

  return (
    <tr>
      <td className="c-inst">{instrumentName(markets, row.instrument)}</td>
      <td className={row.is_long ? "side-long c-side" : "side-short c-side"}>
        {row.is_long ? "Long" : "Short"}
      </td>
      <td className="c-num c-margin">
        {Number.isFinite(margin) ? `$${formatUsd(margin)}` : row.margin}
      </td>
      <td className="c-num c-notional">
        {Number.isFinite(notional) ? `$${formatUsd(notional)}` : row.notional}
      </td>
      <td className="c-num c-entry">
        {Number.isFinite(entry) ? `$${formatPrice(entry)}` : row.entry_price}
      </td>
      <td className="c-num c-mark">
        {mark != null && mark > 0 ? `$${formatPrice(mark)}` : "—"}
      </td>
      <td className={`c-num c-upnl ${pnlClass(pnl)}`.trim()}>
        {pnl == null ? "—" : formatMoney(pnl)}
      </td>
      <td className={`c-num c-roe ${pnlClass(roe)}`.trim()}>
        {roe == null ? "—" : `${roe >= 0 ? "+" : ""}${roe.toFixed(2)}%`}
      </td>
      <td className="c-num c-bust">
        {Number.isFinite(parseAmount(row.bust_price))
          ? `$${formatPrice(parseAmount(row.bust_price))}`
          : row.bust_price}
      </td>
      <td className="c-num c-pos">{row.position}</td>
      <td className="c-action">
        <button
          type="button"
          className="open-btn pos-close-btn"
          disabled={busy}
          onClick={() => onClose(row)}
        >
          {busy ? "Closing…" : "Close"}
        </button>
      </td>
    </tr>
  );
});

type OpenTableProps = {
  markets: Market[];
  rows: PaperPositionOpen[];
  mark: number | null;
  closingId: string | null;
  onClose: (row: PaperPositionOpen) => void;
};

const OpenPositionsTable = memo(function OpenPositionsTable({
  markets,
  rows,
  mark,
  closingId,
  onClose,
}: OpenTableProps) {
  return (
    <div className="pos-table-wrap">
      <table className="pos-table pos-table-open">
        <colgroup>
          <col className="c-inst" />
          <col className="c-side" />
          <col className="c-margin" />
          <col className="c-notional" />
          <col className="c-entry" />
          <col className="c-mark" />
          <col className="c-upnl" />
          <col className="c-roe" />
          <col className="c-bust" />
          <col className="c-pos" />
          <col className="c-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th className="c-num">Margin</th>
            <th className="c-num">Notional</th>
            <th className="c-num">Entry</th>
            <th className="c-num">Mark</th>
            <th className="c-num">uPnL</th>
            <th className="c-num">ROE</th>
            <th className="c-num">Bust</th>
            <th className="c-num">Pos #</th>
            <th className="c-action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowKey = posKey(row.market, row.position);
            return (
              <OpenPositionRow
                key={rowKey}
                markets={markets}
                row={row}
                mark={mark}
                busy={closingId === rowKey}
                onClose={onClose}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

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
  const { closePaper } = useWallet();
  const [tab, setTab] = useState<Tab>("positions");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const openRows = useMemo(() => {
    if (instrumentId == null) return open;
    return open.filter((r) => r.instrument === instrumentId);
  }, [open, instrumentId]);

  const onClose = useCallback(
    async (row: PaperPositionOpen) => {
      const key = posKey(row.market, row.position);
      setCloseError(null);
      setClosingId(key);
      try {
        await closePaper(row.market, row.position);
        await onClosed?.(row);
      } catch (err) {
        setCloseError(err instanceof Error ? err.message : "Close failed");
      } finally {
        setClosingId(null);
      }
    },
    [closePaper, onClosed],
  );

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
          <OpenPositionsTable
            markets={markets}
            rows={openRows}
            mark={mark}
            closingId={closingId}
            onClose={onClose}
          />
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
