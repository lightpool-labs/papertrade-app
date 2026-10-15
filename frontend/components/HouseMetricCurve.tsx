"use client";

import { useEffect, useRef } from "react";
import { formatAxisUsd } from "@/lib/math";

export type HouseMetricKey =
  | "house_funds"
  | "lp_balance"
  | "open_house_pnl"
  | "queue_debt";

export type HouseMetricPoint = {
  t: number;
  house_funds: number;
  lp_balance: number;
  open_house_pnl: number;
  queue_debt: number;
};

export const HOUSE_METRIC_WINDOW_MS = 60 * 60_000;
const TIME_LABEL_MS = 10 * 60_000;

export const HOUSE_METRIC_OPTIONS: { key: HouseMetricKey; label: string }[] = [
  { key: "house_funds", label: "House Funds" },
  { key: "lp_balance", label: "LP Balance" },
  { key: "open_house_pnl", label: "Open House PnL" },
  { key: "queue_debt", label: "Queue Debt" },
];

type Props = {
  seed?: HouseMetricPoint[] | null;
  live: HouseMetricPoint | null;
  metric: HouseMetricKey;
  windowMs?: number;
};

const PAD = { top: 16, right: 48, bottom: 28, left: 12 };
const BUY = "#0ecb81";
const SELL = "#f6465d";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";
const ZERO = "rgba(139, 147, 161, 0.35)";

function dedupeByTime(points: HouseMetricPoint[]): HouseMetricPoint[] {
  if (points.length <= 1) return points;
  const out: HouseMetricPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.t === p.t) {
      out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

function pick(p: HouseMetricPoint, metric: HouseMetricKey): number {
  return p[metric];
}

export function HouseMetricCurve({
  seed = null,
  live,
  metric,
  windowMs = HOUSE_METRIC_WINDOW_MS,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<HouseMetricPoint[]>([]);
  const liveRef = useRef<HouseMetricPoint | null>(null);
  const metricRef = useRef(metric);
  const seedKeyRef = useRef("");

  useEffect(() => {
    metricRef.current = metric;
  }, [metric]);

  useEffect(() => {
    if (!seed?.length) {
      if (seed === null) return;
      pointsRef.current = [];
      seedKeyRef.current = "";
      return;
    }
    const key = `${seed[0].t}:${seed[seed.length - 1].t}:${seed.length}`;
    if (seedKeyRef.current === key) return;
    seedKeyRef.current = key;
    pointsRef.current = dedupeByTime(seed);
  }, [seed]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let alive = true;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * ratio);
      canvas.height = Math.floor(h * ratio);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const frame = () => {
      if (!alive) return;
      const now = Date.now();
      const livePt = liveRef.current;
      const pts = pointsRef.current;
      const m = metricRef.current;

      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (pts.length === 0 && !livePt) {
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for house metrics…", W / 2, H / 2);
        raf = requestAnimationFrame(frame);
        return;
      }

      const t1 = now;
      const t0 = t1 - windowMs;

      let carry: HouseMetricPoint | null = null;
      let startIdx = 0;
      while (startIdx < pts.length && pts[startIdx].t < t0) {
        carry = pts[startIdx];
        startIdx++;
      }

      const series: HouseMetricPoint[] = [];
      if (carry) {
        series.push({ ...carry, t: t0 });
      }
      for (let i = startIdx; i < pts.length; i++) {
        const p = pts[i];
        if (p.t > t1) break;
        if (p.t < t0) continue;
        series.push({ ...p });
      }

      if (livePt) {
        if (series.length === 0) {
          series.push({ ...livePt, t: t0 });
          series.push({ ...livePt, t: t1 });
        } else {
          const last = series[series.length - 1];
          if (last.t < t1) {
            series.push({ ...livePt, t: t1 });
          } else {
            series[series.length - 1] = { ...livePt, t: last.t };
          }
        }
      }

      const drawn = dedupeByTime(series);
      if (drawn.length === 0) {
        raf = requestAnimationFrame(frame);
        return;
      }

      let lo = Infinity;
      let hi = -Infinity;
      for (const p of drawn) {
        const v = pick(p, m);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (lo === hi) {
        lo -= 1;
        hi += 1;
      }
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const spanT = Math.max(1, t1 - t0);
      const xOf = (t: number) => {
        const x = PAD.left + ((t - t0) / spanT) * plotW;
        return Math.min(PAD.left + plotW, Math.max(PAD.left, x));
      };
      const yOf = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 3; i++) {
        const y = PAD.top + (plotH * i) / 3;
        const v = hi - ((hi - lo) * i) / 3;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + plotW, y);
        ctx.stroke();
        ctx.fillText(formatAxisUsd(v), PAD.left + plotW + 6, y);
      }

      if (lo < 0 && hi > 0) {
        ctx.strokeStyle = ZERO;
        ctx.beginPath();
        ctx.moveTo(PAD.left, yOf(0));
        ctx.lineTo(PAD.left + plotW, yOf(0));
        ctx.stroke();
      }

      const openV = pick(drawn[0], m);
      const tipV = pick(drawn[drawn.length - 1], m);
      const up = tipV >= openV;
      const stroke = up ? BUY : SELL;
      const fillTop = up ? "rgba(14, 203, 129, 0.18)" : "rgba(246, 70, 93, 0.16)";

      const poly: { x: number; y: number }[] = [];
      let prevX = 0;
      let prevY = 0;
      let started = false;
      for (let i = 0; i < drawn.length; i++) {
        const p = drawn[i];
        const x = xOf(p.t);
        const y = yOf(pick(p, m));
        if (!started) {
          poly.push({ x, y });
          started = true;
          prevX = x;
          prevY = y;
          continue;
        }
        if (x > prevX) {
          poly.push({ x, y: prevY });
        }
        if (y !== prevY) {
          poly.push({ x, y });
        }
        prevX = x;
        prevY = y;
      }
      const right = PAD.left + plotW;
      if (started && prevX < right) {
        poly.push({ x: right, y: prevY });
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();

      if (poly.length >= 2) {
        const baseY = PAD.top + plotH;
        const grad = ctx.createLinearGradient(0, PAD.top, 0, baseY);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath();
        ctx.moveTo(poly[0].x, baseY);
        for (const pt of poly) ctx.lineTo(pt.x, pt.y);
        ctx.lineTo(poly[poly.length - 1].x, baseY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.lineJoin = "round";
        ctx.lineCap = "butt";
        for (let i = 0; i < poly.length; i++) {
          if (i === 0) ctx.moveTo(poly[i].x, poly[i].y);
          else ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.stroke();
      }
      ctx.restore();

      ctx.fillStyle = MUTED;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const firstLabel = Math.ceil(t0 / TIME_LABEL_MS) * TIME_LABEL_MS;
      for (let t = firstLabel; t <= t1; t += TIME_LABEL_MS) {
        const d = new Date(t);
        const label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        ctx.fillText(label, xOf(t), H - 8);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [windowMs]);

  return (
    <div ref={wrapRef} className="house-oi-curve house-metric-curve">
      <canvas ref={canvasRef} />
    </div>
  );
}
