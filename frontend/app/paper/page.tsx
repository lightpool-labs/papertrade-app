"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HouseActivityBanner } from "@/components/HouseActivityBanner";
import { PaperActivity } from "@/components/PaperActivity";
import {
  PaperRewardCurve,
  type PaperMintCurveParams,
} from "@/components/PaperRewardCurve";
import {
  PaperStakeHistoryCurve,
  PAPER_STAKE_WINDOW_MS,
  type PaperStakeHistoryPoint,
} from "@/components/PaperStakeHistoryCurve";
import {
  PaperStakingRevenueBars,
  PAPER_REVENUE_WINDOW_MS,
  sumPositiveRevenueDelta,
  type RevenuePoint,
} from "@/components/PaperStakingRevenueBars";
import { TopBar } from "@/components/TopBar";
import { useWallet } from "@/components/WalletProvider";
import {
  getPaper,
  getPaperStakeHistory,
  listMarkets,
  type PaperStake,
} from "@/lib/api";
import { formatAmount, formatUsd, parseAmount } from "@/lib/math";
import { subscribePaperStake } from "@/lib/paperStakeWs";

function money(raw: string): string {
  const formatted = formatAmount(raw);
  if (formatted === "—") return "—";
  if (formatted.startsWith("-")) return `-$${formatted.slice(1)}`;
  return `$${formatted}`;
}

function paperAmt(raw: string): string {
  const formatted = formatAmount(raw);
  return formatted === "—" ? "—" : formatted;
}

function shortAddr(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "—";
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function stakeUiEqual(a: PaperStake, b: PaperStake): boolean {
  return (
    a.paper_raw === b.paper_raw &&
    a.staked_raw === b.staked_raw &&
    a.claimable_raw === b.claimable_raw &&
    a.pending_reward_raw === b.pending_reward_raw &&
    a.reward_pool_raw === b.reward_pool_raw &&
    a.total_staked_raw === b.total_staked_raw &&
    a.rewards_claimed_raw === b.rewards_claimed_raw &&
    a.total_staker_rewards_raw === b.total_staker_rewards_raw &&
    a.mint_rate_raw === b.mint_rate_raw &&
    a.tracked_lp_raw === b.tracked_lp_raw &&
    a.tail_hwm_raw === b.tail_hwm_raw &&
    a.total_supply_raw === b.total_supply_raw &&
    a.staked_supply_raw === b.staked_supply_raw &&
    a.stake_share_pct === b.stake_share_pct &&
    a.stake_ratio_pct === b.stake_ratio_pct &&
    a.reward_rate === b.reward_rate
  );
}

function historyEqual(
  a: PaperStakeHistoryPoint | null,
  b: PaperStakeHistoryPoint,
): boolean {
  return (
    !!a &&
    a.staking_revenue === b.staking_revenue &&
    a.total_paper_supply === b.total_paper_supply &&
    a.total_staking_reward === b.total_staking_reward
  );
}

function PaperBody() {
  const {
    address,
    claimPaper,
    stakePaper,
    unstakePaper,
  } = useWallet();
  const [paperMarket, setPaperMarket] = useState("");
  const [stake, setStake] = useState<PaperStake | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [historySeed, setHistorySeed] = useState<PaperStakeHistoryPoint[] | null>(
    null,
  );
  const [liveHistory, setLiveHistory] = useState<PaperStakeHistoryPoint | null>(
    null,
  );

  const applyStake = useCallback((next: PaperStake, tsMs = Date.now()) => {
    setStake((prev) => (prev && stakeUiEqual(prev, next) ? prev : next));
    const lifetime = parseAmount(next.total_staker_rewards);
    const hist: PaperStakeHistoryPoint = {
      t: tsMs,
      // Lifetime fees to stakers (monotonic); never reward_pool (drops on claim).
      staking_revenue: lifetime,
      total_paper_supply: parseAmount(next.total_supply),
      total_staking_reward: lifetime,
    };
    setLiveHistory((prev) => (historyEqual(prev, hist) ? prev : hist));
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
    if (!paperMarket.trim()) return;
    let cancelled = false;
    const fromMs = Date.now() - PAPER_STAKE_WINDOW_MS;
    void getPaperStakeHistory(paperMarket, { fromMs, limit: 3600 })
      .then((ticks) => {
        if (cancelled) return;
        const pts: PaperStakeHistoryPoint[] = ticks.map((t) => ({
          t: t.t,
          staking_revenue: Number(t.staking_revenue_raw) / 1_000_000,
          total_paper_supply: Number(t.total_paper_supply_raw) / 1_000_000,
          total_staking_reward: Number(t.total_staking_reward_raw) / 1_000_000,
        }));
        setHistorySeed(pts);
      })
      .catch(() => {
        if (!cancelled) setHistorySeed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [paperMarket]);

  useEffect(() => {
    const user = address?.trim() ?? "";
    if (!paperMarket.trim() || !user) {
      setStake(null);
      setLiveHistory(null);
      return;
    }
    setLoading(true);
    setError(null);
    void getPaper(user, paperMarket)
      .then((next) => {
        applyStake(next);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load stake");
        setLoading(false);
      });

    // Redraw at most once per second; keep the latest WS tick until then.
    const REDRAW_MS = 1_000;
    let timer = 0;
    let lastFlush = 0;
    let pending: {
      next: PaperStake;
      tick: {
        staking_revenue_raw?: number;
        total_paper_supply_raw?: number;
        total_staking_reward_raw?: number;
      };
      tsMs: number;
    } | null = null;

    const flush = () => {
      const p = pending;
      pending = null;
      if (!p) return;
      lastFlush = Date.now();
      applyStake(p.next, p.tsMs);
      const hist: PaperStakeHistoryPoint = {
        t: p.tsMs,
        staking_revenue: Number(p.tick.staking_revenue_raw ?? 0) / 1_000_000,
        total_paper_supply:
          Number(p.tick.total_paper_supply_raw ?? 0) / 1_000_000,
        total_staking_reward:
          Number(p.tick.total_staking_reward_raw ?? 0) / 1_000_000,
      };
      setLiveHistory((prev) => (historyEqual(prev, hist) ? prev : hist));
      setLoading(false);
      setError(null);
    };

    const unsub = subscribePaperStake(paperMarket, user, {
      onStake: (next, tick, tsMs) => {
        pending = { next, tick, tsMs };
        if (timer) return;
        const wait = Math.max(0, REDRAW_MS - (Date.now() - lastFlush));
        timer = window.setTimeout(() => {
          timer = 0;
          flush();
        }, wait);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
    return () => {
      unsub();
      if (timer) window.clearTimeout(timer);
      pending = null;
    };
  }, [paperMarket, address, applyStake]);

  const revenueSeed = useMemo((): RevenuePoint[] | null => {
    if (historySeed == null) return null;
    // Prefer lifetime total_staking_reward; old ticks may have wrongly stored reward_pool
    // in staking_revenue — use max of the two so the series stays non-decreasing.
    let peak = 0;
    return historySeed.map((p) => {
      const raw = Math.max(p.total_staking_reward, p.staking_revenue);
      peak = Math.max(peak, Number.isFinite(raw) ? raw : 0);
      return { t: p.t, v: peak };
    });
  }, [historySeed]);

  const liveRevenue = liveHistory
    ? Math.max(
        liveHistory.total_staking_reward,
        liveHistory.staking_revenue,
      )
    : null;

  const revenue1hIn = useMemo(() => {
    if (revenueSeed == null) return null;
    return sumPositiveRevenueDelta(
      revenueSeed,
      liveRevenue,
      PAPER_REVENUE_WINDOW_MS,
    );
  }, [revenueSeed, liveRevenue]);

  const runAction = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (address?.trim() && paperMarket.trim()) {
        const next = await getPaper(address, paperMarket);
        applyStake(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const onClaim = () => {
    if (!paperMarket) return;
    void runAction("claim", () => claimPaper(paperMarket));
  };

  const onStake = () => {
    if (!paperMarket) return;
    const amount = Number(stakeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a positive stake amount");
      return;
    }
    void runAction("stake", async () => {
      await stakePaper(paperMarket, amount);
      setStakeAmount("");
    });
  };

  const onUnstake = () => {
    if (!paperMarket) return;
    const amount = Number(unstakeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a positive unstake amount");
      return;
    }
    void runAction("unstake", async () => {
      await unstakePaper(paperMarket, amount);
      setUnstakeAmount("");
    });
  };

  const claimableRaw = stake?.claimable_raw ?? 0;
  const paperWallet = stake ? parseAmount(stake.paper) : 0;
  const stakedHuman = stake ? parseAmount(stake.staked) : 0;

  const mintParams = useMemo((): PaperMintCurveParams | null => {
    if (!stake) return null;
    return {
      flatThreshold: stake.flat_threshold_raw ?? 0,
      flatRatePpm: stake.flat_rate_ppm ?? 0,
      tailDecayScale: stake.tail_decay_scale_raw ?? 0,
      trackedLp: stake.tracked_lp_raw ?? 0,
      tailHwm: stake.tail_hwm_raw ?? 0,
    };
  }, [stake]);

  const mintRateLabel = stake?.mint_rate
    ? `${formatAmount(stake.mint_rate)} PAPER/$`
    : "—";

  return (
    <div className="paper-shell paper-shell-with-activity">
      <TopBar />
      <main className="paper-main">
        {error ? <div className="paper-error">{error}</div> : null}
        {loading && !stake ? (
          <div className="bottom-empty">Loading…</div>
        ) : !address?.trim() ? (
          <div className="bottom-empty">Connect wallet to view PAPER stake</div>
        ) : !paperMarket.trim() ? (
          <div className="bottom-empty">Waiting for market config…</div>
        ) : !stake ? (
          <div className="bottom-empty">Loading stake…</div>
        ) : (
          <div className="paper-layout">
            <div className="paper-row-grid paper-row-claim">
              <section className="house-card paper-actions-card">
                <h2>Claimable Rewards</h2>
                <div className="paper-inline-row paper-claim-row">
                  <div className="ticket-stats account-panel-stats house-stats-list paper-inline-stats">
                    <div>
                      <span>USDC</span>
                      <strong>{money(stake.claimable)}</strong>
                    </div>
                    <div>
                      <span>Pending</span>
                      <strong>{money(stake.pending_reward)}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="paper-action-btn paper-claim-btn"
                    disabled={busy != null || claimableRaw === 0}
                    onClick={onClaim}
                  >
                    {busy === "claim" ? "Claiming…" : "Claim"}
                  </button>
                </div>

                <div className="paper-actions-stack">
                  <div className="paper-form">
                    <div className="paper-inline-row">
                      <input
                        className="paper-input"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        aria-label="Stake amount"
                        value={stakeAmount}
                        onChange={(e) => setStakeAmount(e.target.value)}
                      />
                      <button
                        type="button"
                        className="paper-action-btn"
                        disabled={busy != null || paperWallet <= 0}
                        onClick={onStake}
                      >
                        {busy === "stake" ? "Staking…" : "Stake PAPER"}
                      </button>
                    </div>
                    <div className="paper-form-hint">
                      Available {paperAmt(stake.paper)} PAPER
                      {Number.isFinite(paperWallet) && paperWallet > 0 ? (
                        <button
                          type="button"
                          className="paper-max-btn"
                          onClick={() => setStakeAmount(String(paperWallet))}
                        >
                          Max
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="paper-form">
                    <div className="paper-inline-row">
                      <input
                        className="paper-input"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="0"
                        aria-label="Unstake amount"
                        value={unstakeAmount}
                        onChange={(e) => setUnstakeAmount(e.target.value)}
                      />
                      <button
                        type="button"
                        className="paper-action-btn paper-action-btn-secondary"
                        disabled={busy != null || stakedHuman <= 0}
                        onClick={onUnstake}
                      >
                        {busy === "unstake" ? "Unstaking…" : "Unstake PAPER"}
                      </button>
                    </div>
                    <div className="paper-form-hint">
                      Staked {paperAmt(stake.staked)} PAPER
                      {Number.isFinite(stakedHuman) && stakedHuman > 0 ? (
                        <button
                          type="button"
                          className="paper-max-btn"
                          onClick={() => setUnstakeAmount(String(stakedHuman))}
                        >
                          Max
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>

              <section className="house-card">
                <h2>Rewards</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  <div>
                    <span>Rewards Claimed</span>
                    <strong>{money(stake.rewards_claimed)}</strong>
                  </div>
                  <div>
                    <span>Your Stake Share</span>
                    <strong>≈ {stake.stake_share_pct}%</strong>
                  </div>
                  <div>
                    <span>Total Staker Rewards</span>
                    <strong>{money(stake.total_staker_rewards)}</strong>
                  </div>
                  <div>
                    <span>Reward Rate</span>
                    <strong>{stake.reward_rate}</strong>
                  </div>
                  <div>
                    <span>Reward Token</span>
                    <strong>{stake.reward_token}</strong>
                  </div>
                </div>
              </section>
            </div>

            <section className="house-card paper-revenue-card paper-stat-revenue">
              <div className="house-oi-chart-head">
                <h2>Staking Revenue</h2>
                <div className="house-oi-legend">
                  <span className="house-metric-legend">
                    1h Δ{" "}
                    {revenue1hIn != null && Number.isFinite(revenue1hIn)
                      ? `+$${formatUsd(revenue1hIn, 2)}`
                      : "—"}
                  </span>
                </div>
              </div>
              <PaperStakingRevenueBars
                seed={revenueSeed}
                live={liveRevenue}
                windowMs={PAPER_REVENUE_WINDOW_MS}
              />
            </section>

            <div className="paper-row-grid paper-row-paper">
              <section className="house-card">
                <h2>Paper Staked</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  <div>
                    <span>Staked</span>
                    <strong>{paperAmt(stake.staked)} PAPER</strong>
                  </div>
                  <div>
                    <span>Your share</span>
                    <strong>{stake.stake_share_pct}%</strong>
                  </div>
                  <div>
                    <span>Total staked</span>
                    <strong>{paperAmt(stake.total_staked)} PAPER</strong>
                  </div>
                </div>
              </section>

              <section className="house-card">
                <h2>Paper</h2>
                <div className="ticket-stats account-panel-stats house-stats-list">
                  <div>
                    <span>Wallet</span>
                    <strong>{paperAmt(stake.paper)} PAPER</strong>
                  </div>
                  <div>
                    <span>Total Supply</span>
                    <strong>{paperAmt(stake.total_supply)}</strong>
                  </div>
                  <div>
                    <span>Staked Supply</span>
                    <strong>{paperAmt(stake.staked_supply)}</strong>
                  </div>
                  <div>
                    <span>Stake Ratio</span>
                    <strong>{stake.stake_ratio_pct}%</strong>
                  </div>
                  <div>
                    <span>Token</span>
                    <strong title={stake.paper_token}>
                      {shortAddr(stake.paper_token)}
                    </strong>
                  </div>
                  <div>
                    <span>Staking Contract</span>
                    <strong title={stake.staking_contract}>
                      {shortAddr(stake.staking_contract)}
                    </strong>
                  </div>
                </div>
              </section>
            </div>

            <section className="house-card paper-history-chart-card paper-stat-supply">
              <div className="house-oi-chart-head">
                <h2>Total Paper Supply</h2>
                <div className="house-oi-legend">
                  <span className="house-metric-legend">
                    1h{" "}
                    {liveHistory
                      ? formatUsd(
                          liveHistory.total_paper_supply,
                          liveHistory.total_paper_supply >= 1000 ? 0 : 2,
                        )
                      : paperAmt(stake.total_supply)}
                  </span>
                </div>
              </div>
              <PaperStakeHistoryCurve
                seed={historySeed}
                live={liveHistory}
                metric="total_paper_supply"
                windowMs={PAPER_STAKE_WINDOW_MS}
              />
            </section>

            {paperMarket ? <PaperActivity market={paperMarket} /> : null}

            <section className="house-card paper-history-chart-card paper-stat-reward">
              <div className="house-oi-chart-head">
                <h2>Total Staking Rewards</h2>
                <div className="house-oi-legend">
                  <span className="house-metric-legend">
                    1h{" "}
                    {liveHistory
                      ? `$${formatUsd(liveHistory.total_staking_reward, 2)}`
                      : money(stake.total_staker_rewards)}
                  </span>
                </div>
              </div>
              <PaperStakeHistoryCurve
                seed={historySeed}
                live={liveHistory}
                metric="total_staking_reward"
                windowMs={PAPER_STAKE_WINDOW_MS}
              />
            </section>

            <section className="house-card paper-reward-chart-card">
              <div className="house-oi-chart-head">
                <h2>Reward Curve</h2>
                <div className="house-oi-legend">
                  <span className="house-metric-legend">{mintRateLabel}</span>
                </div>
              </div>
              <p className="paper-reward-curve-hint">
                PAPER per $ loss vs tracked LP
              </p>
              <PaperRewardCurve params={mintParams} />
            </section>
          </div>
        )}
      </main>
      <HouseActivityBanner market={paperMarket} />
    </div>
  );
}

export default function PaperPage() {
  return <PaperBody />;
}
