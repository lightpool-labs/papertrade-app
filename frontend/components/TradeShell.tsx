"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { InstrumentHeader } from "@/components/InstrumentHeader";
import { CandleChart } from "@/components/CandleChart";
import { MarkPriceCurve } from "@/components/MarkPriceCurve";
import { PaperTicket } from "@/components/PaperTicket";
import { PositionsPanel } from "@/components/PositionsPanel";
import { WalletProvider, useWallet } from "@/components/WalletProvider";
import {
  getAccount,
  listHistory,
  listMarkets,
  listPositions,
  type Market,
  type PaperAccount,
  type PaperPositionHistory,
  type PaperPositionOpen,
} from "@/lib/api";
import { isCandleInterval, type ChartView } from "@/lib/chartView";
import {
  changePctVsPrevDay,
  fetchHlDayContext,
} from "@/lib/hlDayChange";
import { subscribeOracleMark } from "@/lib/markWs";
import { sumUnrealizedPnl } from "@/lib/math";
import { subscribePaperUser } from "@/lib/paperUserWs";

function TradeBody() {
  const params = useParams<{ slug?: string }>();
  const slug = (params?.slug ?? "btc").toLowerCase();
  const { address } = useWallet();

  const [markets, setMarkets] = useState<Market[]>([]);
  const [selected, setSelected] = useState<Market | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartView, setChartView] = useState<ChartView>("tick");
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [openPositions, setOpenPositions] = useState<PaperPositionOpen[]>([]);
  const [history, setHistory] = useState<PaperPositionHistory[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);

  const prevDayPxRef = useRef<number | null>(null);
  const markRef = useRef<number | null>(null);

  const refreshMarkets = useCallback(async () => {
    setError(null);
    try {
      const next = await listMarkets();
      setMarkets(next);
      const hit =
        next.find((m) => m.slug.toLowerCase() === slug) ?? next[0] ?? null;
      setSelected(hit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load markets");
    }
  }, [slug]);

  const refreshAccountAndPositions = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      if (!silent) setPosLoading(true);
      setPosError(null);
      const market = selected?.paper_market?.trim() || undefined;

      // Fetch independently — account get_acct 404 must not blank the positions table.
      if (market) {
        try {
          setAccount(await getAccount(address, market));
        } catch {
          setAccount(null);
        }
      } else {
        setAccount(null);
      }

      try {
        const [pos, hist] = await Promise.all([
          listPositions(address, { market, status: "open" }),
          listHistory(address, market),
        ]);
        setOpenPositions(pos.open ?? []);
        setHistory(hist.history ?? []);
      } catch (err) {
        setPosError(
          err instanceof Error ? err.message : "Failed to load positions",
        );
      } finally {
        if (!silent) setPosLoading(false);
      }
    },
    [address, selected?.paper_market],
  );

  const onOpened = useCallback(() => {
    void refreshAccountAndPositions({ silent: true });
  }, [refreshAccountAndPositions]);

  const onClosed = useCallback(
    (row: PaperPositionOpen) => {
      setOpenPositions((prev) =>
        prev.filter(
          (p) => !(p.market === row.market && p.position === row.position),
        ),
      );
      void refreshAccountAndPositions({ silent: true });
    },
    [refreshAccountAndPositions],
  );

  useEffect(() => {
    void refreshMarkets();
  }, [refreshMarkets]);

  useEffect(() => {
    void refreshAccountAndPositions();
    // Slow fallback if WS drops; primary refresh is paper.user below.
    const timer = window.setInterval(() => {
      void refreshAccountAndPositions({ silent: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshAccountAndPositions]);

  useEffect(() => {
    if (!address?.trim()) return;
    let debounce: number | null = null;
    const unsub = subscribePaperUser(address, {
      onEvent: () => {
        if (debounce != null) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          void refreshAccountAndPositions({ silent: true });
        }, 50);
      },
    });
    return () => {
      if (debounce != null) window.clearTimeout(debounce);
      unsub();
    };
  }, [address, refreshAccountAndPositions]);

  useEffect(() => {
    if (!selected?.hl_symbol?.trim()) {
      prevDayPxRef.current = null;
      setChangePct(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const ctx = await fetchHlDayContext(selected.hl_symbol);
        if (cancelled || !ctx) return;
        prevDayPxRef.current = ctx.prevDayPx;
        setChangePct(
          changePctVsPrevDay(markRef.current, ctx.prevDayPx) ?? ctx.changePct,
        );
      } catch {
        // keep last baseline
      }
    };

    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selected?.hl_symbol]);

  useEffect(() => {
    if (!selected?.price_market?.trim()) {
      setMark(null);
      markRef.current = null;
      setChangePct(null);
      return;
    }

    const unsub = subscribeOracleMark(selected.price_market, {
      onTick: (tick) => {
        const value = Number(tick.mark_price);
        if (!Number.isFinite(value)) return;
        markRef.current = value;
        setMark(value);
        const pct = changePctVsPrevDay(value, prevDayPxRef.current);
        if (pct != null) setChangePct(pct);
      },
    });

    return () => {
      unsub();
    };
  }, [selected]);

  const liveOpenPnl = useMemo(
    () => sumUnrealizedPnl(openPositions, mark, selected?.id ?? null),
    [openPositions, mark, selected?.id],
  );

  return (
    <div className="app-shell">
      <div className="shell-top">
        <TopBar />
      </div>

      <div className="chart-stack">
        <InstrumentHeader
          markets={markets}
          selected={selected}
          mark={mark}
          changePct={changePct}
          chartView={chartView}
          onChartViewChange={setChartView}
        />
        {error ? <div className="banner error">{error}</div> : null}
        {chartView === "tick" ? (
          <MarkPriceCurve
            key={selected?.price_market ?? selected?.slug ?? "none"}
            mark={mark}
          />
        ) : isCandleInterval(chartView) ? (
          <CandleChart market={selected} interval={chartView} />
        ) : null}
      </div>

      <PaperTicket
        market={selected}
        mark={mark}
        account={account}
        accountLoading={posLoading}
        openPnl={liveOpenPnl}
        onOpened={onOpened}
      />

      <PositionsPanel
        markets={markets}
        open={openPositions}
        history={history}
        loading={posLoading}
        error={posError}
        instrumentId={selected?.id ?? null}
        mark={mark}
        account={account}
        openPnl={liveOpenPnl}
        onClosed={onClosed}
      />
    </div>
  );
}

export function TradeShell() {
  return (
    <WalletProvider>
      <TradeBody />
    </WalletProvider>
  );
}
