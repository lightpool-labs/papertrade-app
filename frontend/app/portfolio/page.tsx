"use client";

import { useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { PositionsPanel } from "@/components/PositionsPanel";
import { AccountStrip } from "@/components/AccountStrip";
import { useWallet } from "@/components/WalletProvider";
import {
  listHistory,
  listMarkets,
  listPositions,
  type Market,
  type PaperAccount,
  type PaperPositionHistory,
  type PaperPositionOpen,
} from "@/lib/api";
import { getAccountWithUsdcAvailable } from "@/lib/bridge";
import { subscribePaperUser } from "@/lib/paperUserWs";

function PortfolioBody() {
  const { address } = useWallet();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [open, setOpen] = useState<PaperPositionOpen[]>([]);
  const [history, setHistory] = useState<PaperPositionHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterSlug, setFilterSlug] = useState<string>("all");

  const paperMarket = markets[0]?.paper_market;

  const refresh = useCallback(async () => {
    const user = address?.trim() ?? "";
    if (!user) {
      setAccount(null);
      setOpen([]);
      setHistory([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [acct, pos, hist] = await Promise.all([
        getAccountWithUsdcAvailable(user, paperMarket),
        listPositions(user, { market: paperMarket, status: "all" }),
        listHistory(user, paperMarket),
      ]);
      setAccount(acct);
      setOpen(pos.open ?? []);
      setHistory(hist.history ?? pos.history ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load portfolio");
    } finally {
      setLoading(false);
    }
  }, [address, paperMarket]);

  useEffect(() => {
    void listMarkets()
      .then(setMarkets)
      .catch(() => setMarkets([]));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!address?.trim()) return;
    let debounce: number | null = null;
    const unsub = subscribePaperUser(address, {
      onEvent: () => {
        if (debounce != null) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          void refresh();
        }, 50);
      },
    });
    return () => {
      if (debounce != null) window.clearTimeout(debounce);
      unsub();
    };
  }, [address, refresh]);

  const instrumentId =
    filterSlug === "all"
      ? null
      : (markets.find((m) => m.slug === filterSlug)?.id ?? null);

  const filteredOpen =
    instrumentId == null
      ? open
      : open.filter((r) => r.instrument === instrumentId);
  const filteredHistory =
    instrumentId == null
      ? history
      : history.filter((r) => r.instrument === instrumentId);

  return (
    <div className="stub-shell portfolio-shell">
      <TopBar />
      <main className="portfolio-main">
        <div className="portfolio-head">
          <h1>Portfolio</h1>
          <select
            className="chart-view-select"
            value={filterSlug}
            onChange={(e) => setFilterSlug(e.target.value)}
          >
            <option value="all">All instruments</option>
            {markets.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <AccountStrip account={account} loading={loading} />
        <PositionsPanel
          markets={markets}
          open={filteredOpen}
          history={filteredHistory}
          loading={loading}
          error={error}
        />
      </main>
    </div>
  );
}

export default function PortfolioPage() {
  return <PortfolioBody />;
}
