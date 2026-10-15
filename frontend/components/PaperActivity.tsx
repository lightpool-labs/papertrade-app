"use client";

import { useEffect, useState } from "react";
import { getPaperActivity, type PaperActivityItem } from "@/lib/api";
import { formatAmount, parseAmount } from "@/lib/math";
import { subscribePaperActivity } from "@/lib/paperActivityWs";

const MAX_ITEMS = 60;

type Props = {
  market: string;
};

function shortWallet(raw: string): string {
  const s = raw.trim();
  if (s.length <= 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "close_loss":
      return "Close loss";
    case "liquidated":
      return "Liqd";
    case "staked":
      return "Stake";
    case "unstaked":
      return "Unstake";
    default:
      return kind;
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "close_loss":
      return "paper-act-close";
    case "liquidated":
      return "paper-act-liqd";
    case "staked":
      return "paper-act-stake";
    case "unstaked":
      return "paper-act-unstake";
    default:
      return "";
  }
}

function paperLabel(raw: string): string {
  const formatted = formatAmount(raw);
  return formatted === "—" ? "—" : `${formatted} PAPER`;
}

function pnlLabel(item: PaperActivityItem): string {
  if (item.pnl == null && item.pnl_raw == null) return "";
  let n = NaN;
  if (item.pnl_raw != null) {
    const pr = Number(item.pnl_raw);
    if (Number.isFinite(pr)) n = pr / 1_000_000;
  }
  if (!Number.isFinite(n)) n = parseAmount(item.pnl ?? "");
  if (!Number.isFinite(n)) return "";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${formatAmount(Math.abs(n))}`;
}

function activityKey(item: PaperActivityItem, i: number): string {
  return `${item.kind}:${item.block_num}:${item.user}:${item.position ?? ""}:${item.amount_raw}:${i}`;
}

export function PaperActivity({ market }: Props) {
  const [items, setItems] = useState<PaperActivityItem[]>([]);

  useEffect(() => {
    if (!market.trim()) return;
    let cancelled = false;
    void getPaperActivity(market, 60)
      .then((list) => {
        if (!cancelled) setItems(list.slice(0, MAX_ITEMS));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [market]);

  useEffect(() => {
    if (!market.trim()) return;
    const unsub = subscribePaperActivity({
      onEvent: (item) => {
        if (
          market.trim() &&
          item.market &&
          item.market.toLowerCase() !== market.trim().toLowerCase()
        ) {
          return;
        }
        setItems((prev) => {
          const next = [item, ...prev];
          return next.slice(0, MAX_ITEMS);
        });
      },
    });
    return unsub;
  }, [market]);

  return (
    <section className="house-card paper-activity-card">
      <h2>Paper Activity</h2>
      {items.length === 0 ? (
        <div className="bottom-empty paper-activity-empty">
          No close-loss / liqd / stake / unstake yet
        </div>
      ) : (
        <ul className="paper-activity-list">
          {items.map((item, i) => (
            <li
              key={activityKey(item, i)}
              className={`paper-activity-row ${kindClass(item.kind)}`}
            >
              <span className="paper-activity-kind">{kindLabel(item.kind)}</span>
              <span className="paper-activity-user" title={item.user}>
                {shortWallet(item.user)}
              </span>
              <span className="paper-activity-amount">
                {paperLabel(item.amount)}
              </span>
              {pnlLabel(item) ? (
                <span className="paper-activity-pnl">{pnlLabel(item)}</span>
              ) : (
                <span className="paper-activity-pnl" />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
