"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { WalletProvider } from "@/components/WalletProvider";
import { getHouse, listMarkets, type PaperHouse } from "@/lib/api";
import { formatAmount } from "@/lib/math";

function money(raw: string): string {
  const formatted = formatAmount(raw);
  if (formatted === "—") return "—";
  if (formatted.startsWith("-")) return `-$${formatted.slice(1)}`;
  return `$${formatted}`;
}

function HouseBody() {
  const [house, setHouse] = useState<PaperHouse | null>(null);
  const [paperMarket, setPaperMarket] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (market: string) => {
    if (!market.trim()) {
      setHouse(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setHouse(await getHouse(market));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load house");
      setHouse(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void listMarkets()
      .then((markets) => {
        const m = markets[0]?.paper_market?.trim() ?? "";
        setPaperMarket(m);
      })
      .catch(() => setPaperMarket(""));
  }, []);

  useEffect(() => {
    if (!paperMarket) return;
    void refresh(paperMarket);
    const timer = window.setInterval(() => {
      void refresh(paperMarket);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [paperMarket, refresh]);

  const lpRows = house
    ? [
        { label: "Free cash", value: money(house.free_cash) },
        { label: "Side bucket", value: money(house.side_bucket) },
        { label: "Tracked LP", value: money(house.tracked_lp) },
        { label: "Tail HWM", value: money(house.tail_hwm) },
      ]
    : [];

  const feeRows = house
    ? [
        { label: "Staker fee acc", value: money(house.staker_fee_acc) },
        { label: "Dev fee acc", value: money(house.dev_fee_acc) },
      ]
    : [];

  const queueRows = house
    ? [
        { label: "Total queued", value: money(house.total_queued) },
        { label: "Queue head", value: String(house.queue_head) },
        { label: "Queue tail", value: String(house.queue_tail) },
      ]
    : [];

  return (
    <div className="stub-shell house-shell">
      <TopBar />
      <main className="house-main">
        {error ? <div className="banner error">{error}</div> : null}

        {house?.queue_nonempty ? (
          <div className="banner warn">
            Payout queue is non-empty — winners wait for harvest (FIFO).
          </div>
        ) : null}

        {loading && !house ? (
          <div className="bottom-empty">Loading house…</div>
        ) : !house ? (
          <div className="bottom-empty">No house data</div>
        ) : (
          <div className="house-grid">
            <section className="house-card">
              <h2>LP buckets</h2>
              <div className="ticket-stats account-panel-stats">
                {lpRows.map((r) => (
                  <div key={r.label}>
                    <span>{r.label}</span>
                    <strong>{r.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="house-card">
              <h2>Queue</h2>
              <div className="ticket-stats account-panel-stats">
                {queueRows.map((r) => (
                  <div key={r.label}>
                    <span>{r.label}</span>
                    <strong>{r.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="house-card">
              <h2>Fee accruals</h2>
              <div className="ticket-stats account-panel-stats">
                {feeRows.map((r) => (
                  <div key={r.label}>
                    <span>{r.label}</span>
                    <strong>{r.value}</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function HousePage() {
  return (
    <WalletProvider>
      <HouseBody />
    </WalletProvider>
  );
}
