"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HouseActivityBanner } from "@/components/HouseActivityBanner";
import {
  HouseDebtCurve,
  HOUSE_DEBT_WINDOW_MS,
  type DebtPoint,
} from "@/components/HouseDebtCurve";
import {
  HouseMetricCurve,
  HOUSE_METRIC_OPTIONS,
  HOUSE_METRIC_WINDOW_MS,
  type HouseMetricKey,
  type HouseMetricPoint,
} from "@/components/HouseMetricCurve";
import {
  HouseOiCurve,
  HOUSE_OI_WINDOW_MS,
  type OiPoint,
} from "@/components/HouseOiCurve";
import { HouseQueuePlacement } from "@/components/HouseQueuePlacement";
import { TopBar } from "@/components/TopBar";
import { WalletProvider, useWallet } from "@/components/WalletProvider";
import {
  getHouse,
  getHouseDebtHistory,
  getHouseHistory,
  getHouseOiHistory,
  getHouseQueuePlacement,
  listMarkets,
  type PaperHouse,
  type PaperQueuePlacement,
} from "@/lib/api";
import {
  formatAmount,
  formatMoney,
  formatUsd,
  parseAmount,
} from "@/lib/math";
import { subscribePaperHouse } from "@/lib/paperHouseWs";

function money(raw: string): string {
  const formatted = formatAmount(raw);
  if (formatted === "—") return "—";
  if (formatted.startsWith("-")) return `-$${formatted.slice(1)}`;
  return `$${formatted}`;
}

function pnlClass(raw: string): string {
  const n = parseAmount(raw);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "pnl-win" : "pnl-loss";
}

function metricFromHouse(next: PaperHouse, t: number): HouseMetricPoint | null {
  const house_funds = parseAmount(next.house_funds);
  const lp_balance = parseAmount(next.lp_balance);
  const open_house_pnl = parseAmount(next.open_house_pnl);
  const queue_debt = parseAmount(next.queue_debt);
  if (
    !Number.isFinite(house_funds) ||
    !Number.isFinite(lp_balance) ||
    !Number.isFinite(open_house_pnl) ||
    !Number.isFinite(queue_debt)
  ) {
    return null;
  }
  return { t, house_funds, lp_balance, open_house_pnl, queue_debt };
}

function HouseBody() {
  const { address } = useWallet();
  const [house, setHouse] = useState<PaperHouse | null>(null);
  const [paperMarket, setPaperMarket] = useState<string>("");
  const [oiSeed, setOiSeed] = useState<OiPoint[] | null>(null);
  const [metricSeed, setMetricSeed] = useState<HouseMetricPoint[] | null>(null);
  const [debtSeed, setDebtSeed] = useState<DebtPoint[] | null>(null);
  const [placement, setPlacement] = useState<PaperQueuePlacement | null>(null);
  const [metric, setMetric] = useState<HouseMetricKey>("house_funds");
  const [oiInstrument, setOiInstrument] = useState(0);
  const [oiName, setOiName] = useState("BTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyHouse = useCallback((next: PaperHouse, tsMs: number) => {
    setHouse(next);
    const t = tsMs > 0 ? tsMs : Date.now();
    const metricPt = metricFromHouse(next, t);
    if (metricPt) {
      setMetricSeed((prev) => {
        if (!prev?.length) return [metricPt];
        const last = prev[prev.length - 1];
        if (last.t === t) {
          const copy = prev.slice();
          copy[copy.length - 1] = metricPt;
          return copy;
        }
        const cutoff = t - HOUSE_METRIC_WINDOW_MS;
        const kept = prev.filter((p) => p.t >= cutoff);
        kept.push(metricPt);
        return kept;
      });
      setDebtSeed((prev) => {
        const point: DebtPoint = { t, debt: metricPt.queue_debt };
        if (!prev?.length) return [point];
        const last = prev[prev.length - 1];
        if (last.t === t) {
          const copy = prev.slice();
          copy[copy.length - 1] = point;
          return copy;
        }
        const cutoff = t - HOUSE_DEBT_WINDOW_MS;
        const kept = prev.filter((p) => p.t >= cutoff);
        kept.push(point);
        return kept;
      });
    }
    const prefer =
      next.instruments.find((i) => i.name.toUpperCase() === "BTC") ??
      next.instruments[0];
    if (!prefer) return;
    setOiInstrument(prefer.instrument);
    if (prefer.name?.trim()) setOiName(prefer.name.trim());
    const long = parseAmount(prefer.long);
    const short = parseAmount(prefer.short);
    if (!Number.isFinite(long) || !Number.isFinite(short)) return;
    setOiSeed((prev) => {
      const point: OiPoint = { t, long, short };
      if (!prev?.length) return [point];
      const last = prev[prev.length - 1];
      if (last.t === t) {
        const copy = prev.slice();
        copy[copy.length - 1] = point;
        return copy;
      }
      const cutoff = t - 10 * 60_000;
      const kept = prev.filter((p) => p.t >= cutoff);
      kept.push(point);
      return kept;
    });
  }, []);

  const loadSnapshot = useCallback(
    async (market: string) => {
      if (!market.trim()) {
        setHouse(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await getHouse(market);
        applyHouse(next, Date.now());
        const prefer =
          next.instruments.find((i) => i.name.toUpperCase() === "BTC") ??
          next.instruments[0];
        const instrument = prefer?.instrument ?? 0;
        try {
          const hist = await getHouseOiHistory(market, {
            instrument,
            fromMs: Date.now() - 10 * 60_000,
            limit: 600,
          });
          const points = (hist.ticks ?? [])
            .map((tick) => {
              const long = parseAmount(tick.long);
              const short = parseAmount(tick.short);
              const t = Number(tick.t);
              if (
                !Number.isFinite(long) ||
                !Number.isFinite(short) ||
                !Number.isFinite(t) ||
                t <= 0
              ) {
                return null;
              }
              return { t, long, short };
            })
            .filter((row): row is OiPoint => row != null)
            .sort((a, b) => a.t - b.t);
          if (points.length) {
            setOiSeed(points);
          }
          if (hist.name?.trim()) setOiName(hist.name.trim());
        } catch {
          // keep seed from applyHouse
        }
        try {
          const houseHist = await getHouseHistory(market, {
            fromMs: Date.now() - HOUSE_METRIC_WINDOW_MS,
            limit: 600,
          });
          const points = (houseHist.ticks ?? [])
            .map((tick) => {
              const house_funds = parseAmount(tick.house_funds);
              const lp_balance = parseAmount(tick.lp_balance);
              const open_house_pnl = parseAmount(tick.open_house_pnl);
              const queue_debt = parseAmount(tick.queue_debt);
              const t = Number(tick.t);
              if (
                !Number.isFinite(house_funds) ||
                !Number.isFinite(lp_balance) ||
                !Number.isFinite(open_house_pnl) ||
                !Number.isFinite(queue_debt) ||
                !Number.isFinite(t) ||
                t <= 0
              ) {
                return null;
              }
              return {
                t,
                house_funds,
                lp_balance,
                open_house_pnl,
                queue_debt,
              };
            })
            .filter((row): row is HouseMetricPoint => row != null)
            .sort((a, b) => a.t - b.t);
          if (points.length) {
            setMetricSeed(points);
            setDebtSeed(points.map((p) => ({ t: p.t, debt: p.queue_debt })));
          }
        } catch {
          try {
            const debtHist = await getHouseDebtHistory(market, {
              fromMs: Date.now() - HOUSE_DEBT_WINDOW_MS,
              limit: 600,
            });
            const points = (debtHist.ticks ?? [])
              .map((tick) => {
                const debt = parseAmount(tick.debt);
                const t = Number(tick.t);
                if (!Number.isFinite(debt) || !Number.isFinite(t) || t <= 0) {
                  return null;
                }
                return { t, debt };
              })
              .filter((row): row is DebtPoint => row != null)
              .sort((a, b) => a.t - b.t);
            if (points.length) setDebtSeed(points);
          } catch {
            // keep seed from applyHouse
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load house");
        setHouse(null);
      } finally {
        setLoading(false);
      }
    },
    [applyHouse],
  );

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
    void loadSnapshot(paperMarket);
    const unsub = subscribePaperHouse(paperMarket, {
      onHouse: (house, tsMs) => {
        applyHouse(house, tsMs);
        setLoading(false);
        setError(null);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
    return () => unsub();
  }, [paperMarket, loadSnapshot, applyHouse]);

  useEffect(() => {
    if (!paperMarket || !address?.trim()) {
      setPlacement(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void getHouseQueuePlacement(paperMarket, address)
        .then((next) => {
          if (!cancelled) setPlacement(next);
        })
        .catch(() => {
          if (!cancelled) setPlacement(null);
        });
    };
    load();
    const id = window.setInterval(load, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [paperMarket, address, house?.queue_debt_raw, house?.queue_debt_positions]);

  const positionRows = house
    ? [
        { label: "Open Interest", value: money(house.open_interest) },
        { label: "Open Margin", value: money(house.open_margin) },
        { label: "Open Positions", value: String(house.open_positions ?? 0) },
      ]
    : [];

  const statsComponents = house
    ? [
        { label: "LP Balance", value: money(house.lp_balance), cls: "" },
        {
          label: "Open House PnL",
          value: (() => {
            const n = parseAmount(house.open_house_pnl);
            return Number.isFinite(n)
              ? formatMoney(n)
              : money(house.open_house_pnl);
          })(),
          cls: pnlClass(house.open_house_pnl),
        },
        { label: "Queue Debt", value: money(house.queue_debt), cls: "" },
      ]
    : [];

  const bucketRows = house
    ? [
        { label: "Free cash", value: money(house.free_cash) },
        { label: "Side bucket", value: money(house.side_bucket) },
        { label: "Tracked LP", value: money(house.tracked_lp) },
        { label: "Tail HWM", value: money(house.tail_hwm), splitAfter: true },
        { label: "Staker fee acc", value: money(house.staker_fee_acc) },
        { label: "Dev fee acc", value: money(house.dev_fee_acc) },
      ]
    : [];

  const instruments = house?.instruments ?? [];

  const liveOi = useMemo(() => {
    const row =
      instruments.find((i) => i.instrument === oiInstrument) ??
      instruments.find((i) => i.name.toUpperCase() === "BTC") ??
      instruments[0];
    if (!row) return { long: null as number | null, short: null as number | null };
    const long = parseAmount(row.long);
    const short = parseAmount(row.short);
    return {
      long: Number.isFinite(long) ? long : null,
      short: Number.isFinite(short) ? short : null,
    };
  }, [instruments, oiInstrument]);

  const liveMetric = useMemo(() => {
    if (!house) return null;
    return metricFromHouse(house, Date.now());
  }, [house]);

  const liveDebt = useMemo(() => {
    if (!liveMetric) return null as number | null;
    return liveMetric.queue_debt;
  }, [liveMetric]);

  const liveMetricValue = liveMetric ? liveMetric[metric] : null;

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
          <div className="house-stack">
            <div className="house-row-grid">
              <section className="house-card">
                <h2>Stats</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  <div className="house-stats-funds">
                    <span>House Funds</span>
                    <strong className={pnlClass(house.house_funds)}>
                      {money(house.house_funds)}
                    </strong>
                  </div>
                  {statsComponents.map((r, i) => (
                    <div
                      key={r.label}
                      className={
                        i === statsComponents.length - 1
                          ? "house-section-split"
                          : undefined
                      }
                    >
                      <span>{r.label}</span>
                      <strong className={r.cls}>{r.value}</strong>
                    </div>
                  ))}
                  <div>
                    <span>Volume</span>
                    <strong>{money(house.volume ?? "0")}</strong>
                  </div>
                </div>
              </section>

              <section className="house-card house-metric-chart-card">
                <div className="house-oi-chart-head">
                  <div className="house-metric-head-left">
                    <select
                      className="house-metric-select"
                      value={metric}
                      onChange={(e) =>
                        setMetric(e.target.value as HouseMetricKey)
                      }
                      aria-label="House metric"
                    >
                      {HOUSE_METRIC_OPTIONS.map((opt) => (
                        <option key={opt.key} value={opt.key}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="house-oi-legend">
                    <span className="house-metric-legend">
                      1h{" "}
                      {liveMetricValue != null
                        ? `$${formatUsd(liveMetricValue, 0)}`
                        : "—"}
                    </span>
                  </div>
                </div>
                <HouseMetricCurve
                  seed={metricSeed}
                  live={liveMetric}
                  metric={metric}
                  windowMs={HOUSE_METRIC_WINDOW_MS}
                />
              </section>
            </div>

            <div className="house-row-grid">
              <section className="house-card">
                <h2>User Positions</h2>
                <div className="ticket-stats account-panel-stats house-stats-list house-positions-box">
                  {positionRows.map((r, i) => (
                    <div
                      key={r.label}
                      className={
                        i === positionRows.length - 1
                          ? "house-section-split"
                          : undefined
                      }
                    >
                      <span>{r.label}</span>
                      <strong>{r.value}</strong>
                    </div>
                  ))}
                  {instruments.length > 0 ? (
                    <div className="pos-table-wrap house-oi-table">
                      <table className="pos-table">
                        <thead>
                          <tr>
                            <th>Market</th>
                            <th className="c-num">Long</th>
                            <th className="c-num">Short</th>
                            <th className="c-num">Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {instruments.map((row) => (
                            <tr key={row.instrument}>
                              <td>{row.name}</td>
                              <td className="c-num">{money(row.long)}</td>
                              <td className="c-num">{money(row.short)}</td>
                              <td
                                className={`c-num ${pnlClass(row.net)}`.trim()}
                              >
                                {money(row.net)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="bottom-empty">No open interest yet</div>
                  )}
                </div>
              </section>

              <section className="house-card house-oi-chart-card">
                <div className="house-oi-chart-head">
                  <h2>{oiName} Open Interest</h2>
                  <div className="house-oi-legend">
                    <span className="house-oi-legend-long">
                      Long{" "}
                      {liveOi.long != null
                        ? `$${formatUsd(liveOi.long, 0)}`
                        : "—"}
                    </span>
                    <span className="house-oi-legend-short">
                      Short{" "}
                      {liveOi.short != null
                        ? `$${formatUsd(liveOi.short, 0)}`
                        : "—"}
                    </span>
                  </div>
                </div>
                <HouseOiCurve
                  seed={oiSeed}
                  long={liveOi.long}
                  short={liveOi.short}
                  windowMs={HOUSE_OI_WINDOW_MS}
                />
              </section>
            </div>

            <div className="house-queue-lp-grid">
              <section className="house-card">
                <h2>LP detail</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  {bucketRows.map((r) => (
                    <div
                      key={r.label}
                      className={
                        r.splitAfter ? "house-section-split" : undefined
                      }
                    >
                      <span>{r.label}</span>
                      <strong>{r.value}</strong>
                    </div>
                  ))}
                </div>
              </section>

              <section className="house-card house-queue-debt-card">
                <div className="house-oi-chart-head">
                  <h2>Queue Debt</h2>
                  <div className="house-oi-legend">
                    <span className="house-debt-legend">
                      1h{" "}
                      {liveDebt != null ? `$${formatUsd(liveDebt, 0)}` : "—"}
                    </span>
                  </div>
                </div>
                <HouseDebtCurve
                  seed={debtSeed}
                  debt={liveDebt}
                  windowMs={HOUSE_DEBT_WINDOW_MS}
                />
              </section>

              <section className="house-card">
                <h2>Queue Stats</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  <div>
                    <span>Queue Debt</span>
                    <strong>{money(house.queue_debt)}</strong>
                  </div>
                  <div>
                    <span>Queue Debt Positions</span>
                    <strong>{String(house.queue_debt_positions ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Largest Entry</span>
                    <strong>
                      {(house.queue_largest_raw ?? 0) > 0
                        ? money(house.queue_largest ?? "0")
                        : "None"}
                    </strong>
                  </div>
                  <div>
                    <span>Paid Next</span>
                    <strong>
                      {(house.queue_paid_next_raw ?? 0) > 0
                        ? money(house.queue_paid_next ?? "0")
                        : "None"}
                    </strong>
                  </div>
                </div>
              </section>

              <section className="house-card house-queue-wide-card">
                <HouseQueuePlacement
                  placement={placement}
                  connected={Boolean(address?.trim())}
                />
              </section>
            </div>
          </div>
        )}
      </main>
      <HouseActivityBanner market={paperMarket} />
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
