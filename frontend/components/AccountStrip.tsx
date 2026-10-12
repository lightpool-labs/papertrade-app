"use client";

import type { PaperAccount } from "@/lib/api";
import { formatAmount, formatMoney, parseAmount } from "@/lib/math";

type Props = {
  account: PaperAccount | null;
  loading?: boolean;
  /** ticket = Order value style; panel = Equity tab; strip = horizontal. */
  variant?: "strip" | "ticket" | "panel";
  /** Live unrealized PnL override (Trade page mark-based). */
  openPnl?: number | null;
};

export function AccountStrip({
  account,
  loading,
  variant = "strip",
  openPnl = null,
}: Props) {
  const money = (raw: string) => {
    const formatted = formatAmount(raw);
    if (formatted === "—") return "—";
    if (formatted.startsWith("-")) return `-$${formatted.slice(1)}`;
    return `$${formatted}`;
  };

  const livePnl =
    openPnl != null && Number.isFinite(openPnl)
      ? openPnl
      : account
        ? parseAmount(account.open_pnl)
        : NaN;

  const liveEquity = (() => {
    if (!account) return NaN;
    const base =
      parseAmount(account.available) +
      parseAmount(account.queued) +
      parseAmount(account.margin_in_use);
    if (!Number.isFinite(base)) return parseAmount(account.equity);
    if (Number.isFinite(livePnl)) return base + livePnl;
    return parseAmount(account.equity);
  })();

  const pnlDisplay = Number.isFinite(livePnl) ? formatMoney(livePnl) : "—";
  const equityDisplay = Number.isFinite(liveEquity)
    ? liveEquity < 0
      ? `-$${formatAmount(Math.abs(liveEquity))}`
      : `$${formatAmount(liveEquity)}`
    : "—";

  const cells = [
    { label: "Available", value: account ? money(account.available) : "—", cls: "" },
    { label: "Queued", value: account ? money(account.queued) : "—", cls: "" },
    {
      label: "Margin in use",
      value: account ? money(account.margin_in_use) : "—",
      cls: "",
    },
    {
      label: "Open PnL",
      value: account || openPnl != null ? pnlDisplay : "—",
      cls:
        Number.isFinite(livePnl) && livePnl !== 0
          ? livePnl > 0
            ? "pnl-win"
            : "pnl-loss"
          : "",
    },
    {
      label: "Equity",
      value: account ? equityDisplay : "—",
      cls: "",
    },
  ];

  if (loading && !account) {
    const loadingClass =
      variant === "ticket"
        ? "ticket-stats"
        : variant === "panel"
          ? "account-strip account-panel-row"
          : "account-strip";
    return (
      <div className={loadingClass}>
        <span className="meta-muted">Loading account…</span>
      </div>
    );
  }

  if (variant === "ticket") {
    return (
      <div className="ticket-stats account-ticket-stats">
        {cells.map((c) => (
          <div key={c.label}>
            <span>{c.label}</span>
            <strong className={c.cls || undefined}>{c.value}</strong>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "panel") {
    return (
      <div className="account-strip account-panel-row">
        {cells.map((c) => (
          <div key={c.label} className="account-cell">
            <span className="account-label">{c.label}</span>
            <strong className={`account-value${c.cls ? ` ${c.cls}` : ""}`}>
              {c.value}
            </strong>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="account-strip">
      {cells.map((c) => (
        <div key={c.label} className="account-cell">
          <span className="account-label">{c.label}</span>
          <strong className={`account-value${c.cls ? ` ${c.cls}` : ""}`}>
            {c.value}
          </strong>
        </div>
      ))}
    </div>
  );
}
