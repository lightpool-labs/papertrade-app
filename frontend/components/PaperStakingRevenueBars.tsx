"use client";

import { useEffect, useRef } from "react";
import { formatAxisUsd } from "@/lib/math";

export type RevenuePoint = { t: number; v: number };

export const PAPER_REVENUE_WINDOW_MS = 60 * 60_000;
const BUCKET_MS = 60_000;
const TIME_LABEL_MS = 10 * 60_000;

const PAD = { top: 12, right: 44, bottom: 22, left: 8 };
const UP = "#0ecb81";
const UP_DIM = "rgba(14, 203, 129, 0.4)";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";

type Props = {
  seed?: RevenuePoint[] | null;
  live: number | null;
  windowMs?: number;
};

/** Absolute pool levels per minute bucket (forward-fill). */
function bucketLevels(
  points: RevenuePoint[],
  t0: number,
  t1: number,
  bucketMs: number,
): { t: number; level: number; set: boolean }[] {
  const n = Math.max(1, Math.ceil((t1 - t0) / bucketMs));
  const buckets: { t: number; level: number; set: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    buckets.push({ t: t0 + i * bucketMs, level: 0, set: false });
  }
  let carry = 0;
  let carryOk = false;
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    if (p.t < t0) {
      carry = p.v;
      carryOk = true;
      continue;
    }
    if (p.t > t1) break;
    const idx = Math.min(
      n - 1,
      Math.max(0, Math.floor((p.t - t0) / bucketMs)),
    );
    buckets[idx].level = p.v;
    buckets[idx].set = true;
  }
  let last: number | null = carryOk ? carry : null;
  for (const b of buckets) {
    if (b.set) last = b.level;
    else if (last != null) {
      b.level = last;
      b.set = true;
    }
  }
  return buckets;
}

/** Per-bucket inflow vs previous level (negative clipped — revenue only increases). */
function toDeltas(
  levels: { t: number; level: number; set: boolean }[],
  preLevel: number | null,
): { t: number; v: number }[] {
  let prev = preLevel;
  return levels.map((b) => {
    if (!b.set || prev == null) {
      if (b.set) prev = b.level;
      return { t: b.t, v: 0 };
    }
    const d = Math.max(0, b.level - prev);
    prev = Math.max(prev, b.level);
    return { t: b.t, v: d };
  });
}

/** Drop points older than the chart window (keep one carry). */
function prunePoints(pts: RevenuePoint[], cutoff: number): void {
  let i = 0;
  while (i < pts.length && pts[i].t < cutoff) i++;
  const keepFrom = i > 0 ? i - 1 : 0;
  if (keepFrom > 0) pts.splice(0, keepFrom);
}

function timeLabel(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type HitBar = {
  t0: number;
  t1: number;
  n: number;
  plotLeft: number;
  plotW: number;
  series: { t: number; v: number }[];
  levels: { t: number; level: number; set: boolean }[];
};

export function PaperStakingRevenueBars({
  seed = null,
  live,
  windowMs = PAPER_REVENUE_WINDOW_MS,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const pointsRef = useRef<RevenuePoint[]>([]);
  const liveRef = useRef<number | null>(null);
  const seedKeyRef = useRef("");
  const drawRef = useRef<() => void>(() => {});
  const hitRef = useRef<HitBar | null>(null);
  const hoverIdxRef = useRef<number | null>(null);

  useEffect(() => {
    if (!seed?.length) {
      if (seed === null) return;
      pointsRef.current = [];
      seedKeyRef.current = "";
      drawRef.current();
      return;
    }
    const key = `${seed[0].t}:${seed[seed.length - 1].t}:${seed.length}`;
    if (seedKeyRef.current === key) return;
    seedKeyRef.current = key;
    pointsRef.current = seed.slice().sort((a, b) => a.t - b.t);
    drawRef.current();
  }, [seed]);

  useEffect(() => {
    liveRef.current = live;
    if (live == null || !Number.isFinite(live)) {
      drawRef.current();
      return;
    }
    const pts = pointsRef.current;
    const now = Date.now();
    const bucketT = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const last = pts[pts.length - 1];
    // One sample per minute bucket; only rewrite when the pool level changes.
    if (last && Math.floor(last.t / BUCKET_MS) * BUCKET_MS === bucketT) {
      if (last.v === live) return;
      pts[pts.length - 1] = { t: bucketT, v: live };
    } else {
      pts.push({ t: bucketT, v: live });
    }
    prunePoints(pts, now - PAPER_REVENUE_WINDOW_MS - BUCKET_MS);
    drawRef.current();
  }, [live]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    if (!wrap || !canvas || !tip) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let minuteTimer = 0;

    const resize = () => {
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * ratio);
      canvas.height = Math.floor(h * ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const placeTip = (clientX: number, clientY: number, html: string) => {
      tip.innerHTML = html;
      tip.hidden = false;
      const tipW = Math.max(tip.offsetWidth, 140);
      const tipH = Math.max(tip.offsetHeight, 48);
      let left = clientX + 14;
      let top = clientY - tipH - 10;
      if (left + tipW > window.innerWidth - 8) left = clientX - tipW - 14;
      if (top < 8) top = clientY + 16;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const hideTip = () => {
      tip.hidden = true;
      tip.innerHTML = "";
      hoverIdxRef.current = null;
      drawRef.current();
    };

    const draw = () => {
      const now = Date.now();
      const t1 = Math.ceil(now / BUCKET_MS) * BUCKET_MS;
      const t0 = t1 - windowMs;
      const liveV = liveRef.current;
      prunePoints(pointsRef.current, t0 - BUCKET_MS);
      const pts = pointsRef.current.filter((p) => p.t <= t1);

      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (pts.length === 0 && (liveV == null || !Number.isFinite(liveV))) {
        hitRef.current = null;
        ctx.fillStyle = MUTED;
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for staking revenue…", W / 2, H / 2);
        return;
      }

      const allPts =
        liveV != null && Number.isFinite(liveV)
          ? [...pts, { t: t1 - 1, v: liveV }]
          : pts;

      let preLevel: number | null = null;
      for (const p of allPts) {
        if (p.t < t0 && Number.isFinite(p.v)) preLevel = p.v;
      }

      const levels = bucketLevels(allPts, t0, t1, BUCKET_MS);
      const series = toDeltas(levels, preLevel);

      let hi = 0;
      let any = false;
      for (const p of series) {
        if (!Number.isFinite(p.v) || p.v <= 0) continue;
        any = true;
        hi = Math.max(hi, p.v);
      }
      if (!any) hi = 1;
      const lo = 0;
      const pad = hi * 0.08 || 0.1;
      hi += pad;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const n = series.length;
      const gap = 1;
      const barW = Math.max(1, plotW / n - gap);
      const yOf = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;
      const xOf = (i: number) => PAD.left + (i / n) * plotW;

      hitRef.current = {
        t0,
        t1,
        n,
        plotLeft: PAD.left,
        plotW,
        series,
        levels,
      };

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 2; i++) {
        const y = PAD.top + (plotH * i) / 2;
        const v = hi - ((hi - lo) * i) / 2;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatAxisUsd(v), PAD.left + plotW + 4, y);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();

      const baseY = yOf(0);
      const hoverIdx = hoverIdxRef.current;
      for (let i = 0; i < n; i++) {
        const v = series[i].v;
        if (!Number.isFinite(v) || v <= 0) continue;
        const x = xOf(i);
        const y = yOf(v);
        const top = Math.min(y, baseY);
        const h = Math.max(1, Math.abs(baseY - y));
        const last = i === n - 1;
        const hovered = hoverIdx === i;
        ctx.fillStyle = hovered ? UP : last ? UP : UP_DIM;
        ctx.fillRect(x, top, barW, h);
      }
      ctx.restore();

      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const firstLabel = Math.ceil(t0 / TIME_LABEL_MS) * TIME_LABEL_MS;
      for (let t = firstLabel; t <= t1; t += TIME_LABEL_MS) {
        const i = Math.min(n - 1, Math.max(0, Math.floor((t - t0) / BUCKET_MS)));
        ctx.fillText(timeLabel(t), xOf(i) + barW / 2, H - 6);
      }
    };

    const onMove = (e: MouseEvent) => {
      const hit = hitRef.current;
      if (!hit || hit.n <= 0) {
        hideTip();
        return;
      }
      const wr = wrap.getBoundingClientRect();
      const x = e.clientX - wr.left;
      if (x < hit.plotLeft || x > hit.plotLeft + hit.plotW) {
        hideTip();
        return;
      }
      const idx = Math.min(
        hit.n - 1,
        Math.max(0, Math.floor(((x - hit.plotLeft) / hit.plotW) * hit.n)),
      );
      hoverIdxRef.current = idx;
      const row = hit.series[idx];
      const level = hit.levels[idx];
      const inflow = row?.v ?? 0;
      const pool = level?.set ? level.level : NaN;
      placeTip(
        e.clientX,
        e.clientY,
        `<div class="paper-chart-tip-title">Staking revenue</div>
         <div class="paper-chart-tip-row"><span>Time</span><strong>${timeLabel(row.t)}</strong></div>
         <div class="paper-chart-tip-row"><span>1m inflow</span><strong>${formatAxisUsd(inflow)}</strong></div>
         <div class="paper-chart-tip-row"><span>Lifetime fees</span><strong>${Number.isFinite(pool) ? formatAxisUsd(pool) : "—"}</strong></div>`,
      );
      draw();
    };

    const scheduleMinute = () => {
      const delay = Math.max(250, BUCKET_MS - (Date.now() % BUCKET_MS) + 50);
      minuteTimer = window.setTimeout(() => {
        draw();
        scheduleMinute();
      }, delay);
    };

    drawRef.current = draw;
    resize();
    draw();
    scheduleMinute();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap);
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", hideTip);

    return () => {
      window.clearTimeout(minuteTimer);
      drawRef.current = () => {};
      ro.disconnect();
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", hideTip);
    };
  }, [windowMs]);

  return (
    <div ref={wrapRef} className="house-oi-curve paper-revenue-bars paper-chart-hover">
      <canvas ref={canvasRef} />
      <div ref={tipRef} className="paper-chart-tip" hidden />
    </div>
  );
}

/** Sum of positive minute deltas over the last `windowMs` (fees in). */
export function sumPositiveRevenueDelta(
  points: RevenuePoint[],
  live: number | null,
  windowMs = PAPER_REVENUE_WINDOW_MS,
): number {
  const now = Date.now();
  const t1 = Math.ceil(now / BUCKET_MS) * BUCKET_MS;
  const t0 = t1 - windowMs;
  const all = [...points];
  if (live != null && Number.isFinite(live)) {
    all.push({ t: t1 - 1, v: live });
  }
  all.sort((a, b) => a.t - b.t);
  let pre: number | null = null;
  for (const p of all) {
    if (p.t < t0 && Number.isFinite(p.v)) pre = p.v;
  }
  const levels = bucketLevels(all, t0, t1, BUCKET_MS);
  const deltas = toDeltas(levels, pre);
  let sum = 0;
  for (const d of deltas) {
    if (d.v > 0) sum += d.v;
  }
  return sum;
}
