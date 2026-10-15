"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { HouseActivityBanner } from "@/components/HouseActivityBanner";
import { InstrumentHeader } from "@/components/InstrumentHeader";
import { CandleChart } from "@/components/CandleChart";
import { MarkPriceCurve } from "@/components/MarkPriceCurve";
import { PaperTicket } from "@/components/PaperTicket";
import { PositionsPanel } from "@/components/PositionsPanel";
import { WalletProvider, useWallet } from "@/components/WalletProvider";
import {
  getAccount,
  getMarkHistory,
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
  const [markSeed, setMarkSeed] = useState<{ t: number; p: number }[] | null>(
    null,
  );
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
  /** Locally closed ids — ignore if a stale opens snapshot still includes them. */
  const closedIdsRef = useRef<Set<string>>(new Set());
  /** Skip wholesale opens refresh briefly after a close (poll / stale WS). */
  const suppressOpensUntilRef = useRef(0);

  const posId = useCallback((market: string, position: number) => {
    return `${market.trim().toLowerCase()}:${position}`;
  }, []);

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

  const applyOpenSnapshot = useCallback(
    (next: PaperPositionOpen[]) => {
      const closed = closedIdsRef.current;
      const filtered = next.filter(
        (p) => !closed.has(posId(p.market, p.position)),
      );
      setOpenPositions((prev) => {
        if (
          prev.length === filtered.length &&
          prev.every((row, i) => {
            const n = filtered[i];
            return (
              n &&
              posId(row.market, row.position) === posId(n.market, n.position) &&
              row.margin === n.margin &&
              row.notional === n.notional &&
              row.entry_price === n.entry_price &&
              row.bust_price === n.bust_price &&
              row.is_long === n.is_long
            );
          })
        ) {
          return prev;
        }
        const prevById = new Map(
          prev.map((row) => [posId(row.market, row.position), row]),
        );
        return filtered.map((row) => {
          const id = posId(row.market, row.position);
          const old = prevById.get(id);
          if (
            old &&
            old.margin === row.margin &&
            old.notional === row.notional &&
            old.entry_price === row.entry_price &&
            old.bust_price === row.bust_price &&
            old.is_long === row.is_long &&
            old.instrument === row.instrument
          ) {
            return old;
          }
          return row;
        });
      });
    },
    [posId],
  );

  const refreshAccountAndPositions = useCallback(
    async (opts?: { silent?: boolean; opens?: boolean }) => {
      const silent = opts?.silent === true;
      const wantOpens = opts?.opens !== false;
      const refreshOpens =
        wantOpens && Date.now() >= suppressOpensUntilRef.current;
      if (!silent) setPosLoading(true);
      setPosError(null);
      const market = selected?.paper_market?.trim() || undefined;

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
        if (refreshOpens) {
          const [pos, hist] = await Promise.all([
            listPositions(address, { market, status: "open" }),
            listHistory(address, market),
          ]);
          applyOpenSnapshot(pos.open ?? []);
          setHistory(hist.history ?? []);
        } else {
          const hist = await listHistory(address, market);
          setHistory(hist.history ?? []);
        }
      } catch (err) {
        setPosError(
          err instanceof Error ? err.message : "Failed to load positions",
        );
      } finally {
        if (!silent) setPosLoading(false);
      }
    },
    [address, selected?.paper_market, applyOpenSnapshot],
  );

  const removeOpenPosition = useCallback(
    (market: string, position: number) => {
      closedIdsRef.current.add(posId(market, position));
      suppressOpensUntilRef.current = Date.now() + 3_000;
      setOpenPositions((prev) =>
        prev.filter(
          (p) => posId(p.market, p.position) !== posId(market, position),
        ),
      );
    },
    [posId],
  );

  const onOpened = useCallback(() => {
    suppressOpensUntilRef.current = 0;
    void refreshAccountAndPositions({ silent: true, opens: true });
  }, [refreshAccountAndPositions]);

  const onClosed = useCallback(
    (row: PaperPositionOpen) => {
      removeOpenPosition(row.market, row.position);
      // Account + history only — never replace the open table on close.
      void refreshAccountAndPositions({ silent: true, opens: false });
    },
    [refreshAccountAndPositions, removeOpenPosition],
  );

  useEffect(() => {
    void refreshMarkets();
  }, [refreshMarkets]);

  useEffect(() => {
    void refreshAccountAndPositions();
    const timer = window.setInterval(() => {
      void refreshAccountAndPositions({ silent: true, opens: true });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshAccountAndPositions]);

  useEffect(() => {
    if (!address?.trim()) return;
    let debounce: number | null = null;
    const unsub = subscribePaperUser(address, {
      onEvent: (ev) => {
        const kind = (ev.event ?? "").toLowerCase();
        if (
          (kind === "closed" || kind === "liquidated") &&
          ev.market != null &&
          ev.position != null
        ) {
          removeOpenPosition(ev.market, ev.position);
          if (debounce != null) window.clearTimeout(debounce);
          debounce = window.setTimeout(() => {
            void refreshAccountAndPositions({ silent: true, opens: false });
          }, 50);
          return;
        }
        // Only full open-table refresh on a new open — ignore unknown events.
        if (kind !== "opened") return;
        if (debounce != null) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          suppressOpensUntilRef.current = 0;
          void refreshAccountAndPositions({ silent: true, opens: true });
        }, 50);
      },
    });
    return () => {
      if (debounce != null) window.clearTimeout(debounce);
      unsub();
    };
  }, [address, refreshAccountAndPositions, removeOpenPosition]);

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
    if (!selected?.slug?.trim() || !selected.price_market?.trim()) {
      setMarkSeed(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const fromMs = Date.now() - 10 * 60_000;
        const hist = await getMarkHistory(selected.slug, {
          fromMs,
          limit: 600,
        });
        if (cancelled) return;
        const points = (hist.ticks ?? [])
          .map((tick) => {
            const p = Number(tick.mark_price);
            const t = Number(tick.t);
            if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t) || t <= 0) {
              return null;
            }
            return { t, p };
          })
          .filter((row): row is { t: number; p: number } => row != null)
          .sort((a, b) => a.t - b.t);
        setMarkSeed(points.length ? points : null);
      } catch {
        if (!cancelled) setMarkSeed(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selected?.slug, selected?.price_market]);

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
    <div className="app-shell app-shell-with-activity">
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
            seed={markSeed}
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

      <HouseActivityBanner market={selected?.paper_market} />
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
