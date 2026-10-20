"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { HouseActivityBanner } from "@/components/HouseActivityBanner";
import { DemoPanel } from "@/components/DemoPanel";
import { useDemoPlayer } from "@/hooks/useDemoPlayer";
import { InstrumentHeader } from "@/components/InstrumentHeader";
import { CandleChart } from "@/components/CandleChart";
import { MarkPriceCurve } from "@/components/MarkPriceCurve";
import { PaperTicket } from "@/components/PaperTicket";
import { PositionsPanel } from "@/components/PositionsPanel";
import { useWallet } from "@/components/WalletProvider";
import {
  getMarkHistory,
  listHistory,
  listMarkets,
  listPositions,
  type Market,
  type PaperAccount,
  type PaperPositionHistory,
  type PaperPositionOpen,
} from "@/lib/api";
import { getAccountWithUsdcAvailable } from "@/lib/bridge";
import { isCandleInterval, type ChartView } from "@/lib/chartView";
import {
  changePctVsPrevDay,
  fetchHlDayContext,
} from "@/lib/hlDayChange";
import { subscribeOracleMark } from "@/lib/markWs";
import { demoAccount } from "@/lib/demo";
import { POS_LIQD_EVENT, setFireworksOn } from "@/lib/liqdFireworks";
import { parseAmount, sumUnrealizedPnl } from "@/lib/math";
import { subscribePaperUser } from "@/lib/paperUserWs";

/** Sync check for the ?demo= param, used before the mount effect runs. */
function demoParamSet(): boolean {
  if (typeof window === "undefined") return false;
  const id = new URLSearchParams(window.location.search).get("demo");
  return id != null && id.trim().length > 0;
}

/** Header fallback when the strategy backend is not running in demo mode. */
const DEMO_MARKET: Market = {
  paper_market: "demo",
  quote_decimals: 6,
  liq_buffer_ppm: 0,
  id: 0,
  slug: "btc",
  name: "BTC",
  hl_symbol: "BTC",
  price_market: "",
  max_leverage: 1000,
  min_margin: 0,
  retired: false,
};

function TradeBody() {
  const params = useParams<{ slug?: string }>();
  const slug = (params?.slug ?? "btc").toLowerCase();
  const { address } = useWallet();

  const [demoId, setDemoId] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("demo");
    setDemoId(id && id.trim().length > 0 ? id.trim() : null);
  }, []);
  const demo = useDemoPlayer(demoId, address);
  const demoActive = demo.active;

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
      if (demoActive || demoParamSet()) {
        setMarkets([DEMO_MARKET]);
        setSelected(DEMO_MARKET);
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load markets");
    }
  }, [slug, demoActive]);

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
      if (demoActive) {
        setPosError(null);
        setPosLoading(false);
        return;
      }
      const silent = opts?.silent === true;
      const wantOpens = opts?.opens !== false;
      const refreshOpens =
        wantOpens && Date.now() >= suppressOpensUntilRef.current;
      const user = address?.trim() ?? "";
      if (!user) {
        setAccount(null);
        setOpenPositions([]);
        setHistory([]);
        setPosError(null);
        if (!silent) setPosLoading(false);
        return;
      }
      if (!silent) setPosLoading(true);
      setPosError(null);
      const market = selected?.paper_market?.trim() || undefined;

      setAccount(await getAccountWithUsdcAvailable(user, market));

      try {
        if (refreshOpens) {
          const [pos, hist] = await Promise.all([
            listPositions(user, { market, status: "open" }),
            listHistory(user, market),
          ]);
          applyOpenSnapshot(pos.open ?? []);
          setHistory(hist.history ?? []);
        } else {
          const hist = await listHistory(user, market);
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
    [address, selected?.paper_market, applyOpenSnapshot, demoActive],
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
    if (demoActive) setFireworksOn(true);
  }, [demoActive]);

  useEffect(() => {
    if (!demoActive) return;
    const instrument = selected?.id ?? 0;
    const withInstrument = <T extends { instrument: number }>(rows: T[]): T[] =>
      rows.map((row) =>
        row.instrument === instrument ? row : { ...row, instrument },
      );
    const open = withInstrument(demo.openPositions);
    setOpenPositions(open);
    setHistory(withInstrument(demo.history));
    const margin = open.reduce((sum, row) => {
      const n = parseAmount(row.margin);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    setAccount(demoAccount(address, margin));
  }, [demoActive, demo.openPositions, demo.history, selected?.id, address]);

  useEffect(() => {
    if (!address?.trim() || demoActive) return;
    let debounce: number | null = null;
    const unsub = subscribePaperUser(address, {
      onEvent: (ev) => {
        const kind = (ev.event ?? "").toLowerCase();
        if (
          (kind === "closed" || kind === "liquidated") &&
          ev.market != null &&
          ev.position != null
        ) {
          if (kind === "liquidated") {
            window.dispatchEvent(
              new CustomEvent(POS_LIQD_EVENT, {
                detail: { market: ev.market, position: ev.position },
              }),
            );
            const market = ev.market;
            const position = ev.position;
            window.setTimeout(() => removeOpenPosition(market, position), 1100);
          } else {
            removeOpenPosition(ev.market, ev.position);
          }
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
  }, [address, refreshAccountAndPositions, removeOpenPosition, demoActive]);

  useEffect(() => {
    if (demoActive || !selected?.hl_symbol?.trim()) {
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
  }, [selected?.hl_symbol, demoActive]);

  useEffect(() => {
    if (demoActive || !selected?.slug?.trim() || !selected.price_market?.trim()) {
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
  }, [selected?.slug, selected?.price_market, demoActive]);

  useEffect(() => {
    if (demoActive || !selected?.price_market?.trim()) {
      if (!demoActive) {
        setMark(null);
        markRef.current = null;
        setChangePct(null);
      }
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
  }, [selected, demoActive]);

  const viewMark = demoActive ? demo.mark : mark;
  const viewChangePct = demoActive ? demo.changePct : changePct;

  const liveOpenPnl = useMemo(
    () => sumUnrealizedPnl(openPositions, viewMark, selected?.id ?? null),
    [openPositions, viewMark, selected?.id],
  );

  return (
    <div className={`app-shell app-shell-with-activity${demoActive ? " demo-cards" : ""}`}>
      <div className="shell-top">
        <TopBar />
      </div>

      <div className="chart-stack">
        <InstrumentHeader
          markets={markets}
          selected={selected}
          mark={viewMark}
          changePct={viewChangePct}
          chartView={chartView}
          onChartViewChange={setChartView}
        />
        {error && !demoActive ? <div className="banner error">{error}</div> : null}
        {chartView === "tick" ? (
          <MarkPriceCurve
            key={selected?.price_market ?? selected?.slug ?? "none"}
            mark={viewMark}
            seed={markSeed}
            epoch={demoActive ? demo.seekSeq : undefined}
          />
        ) : isCandleInterval(chartView) ? (
          <CandleChart market={selected} interval={chartView} />
        ) : null}
      </div>

      <PaperTicket
        market={selected}
        mark={viewMark}
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
        mark={viewMark}
        account={account}
        openPnl={liveOpenPnl}
        onClosed={onClosed}
      />

      {demoActive ? <DemoPanel player={demo} /> : null}

      <HouseActivityBanner market={selected?.paper_market} demo={demoActive} fireworks />
    </div>
  );
}

export function TradeShell() {
  return <TradeBody />;
}
