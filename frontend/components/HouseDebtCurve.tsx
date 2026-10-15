"use client";

import { useEffect, useRef } from "react";
import { formatAxisUsd } from "@/lib/math";

export type DebtPoint = { t: number; debt: number };
export const HOUSE_DEBT_WINDOW_MS = 60 * 60_000;
const TIME_LABEL_MS = 10 * 60_000;

type Props = {
  seed?: DebtPoint[] | null;
  debt: number | null;
  windowMs?: number;
};

const PAD = { top: 16, right: 48, bottom: 28, left: 12 };
const LINE = "#f0b90b";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";

function dedupeByTime(points: DebtPoint[]): DebtPoint[] {
  if (points.length <= 1) return points;
  const out: DebtPoint[] = [];
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

export function HouseDebtCurve({
  seed = null,
  debt,
  windowMs = HOUSE_DEBT_WINDOW_MS,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<DebtPoint[]>([]);
  const liveRef = useRef<number | null>(null);
  const seedKeyRef = useRef("");

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
    if (debt == null || !Number.isFinite(debt)) return;
    liveRef.current = debt;
  }, [debt]);

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
      const live = liveRef.current;
      const pts = pointsRef.current;

      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (pts.length === 0 && live == null) {
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for queue debt…", W / 2, H / 2);
        raf = requestAnimationFrame(frame);
        return;
      }

      const t1 = now;
      const t0 = t1 - windowMs;

      let carry: DebtPoint | null = null;
      let startIdx = 0;
      while (startIdx < pts.length && pts[startIdx].t < t0) {
        carry = pts[startIdx];
        startIdx++;
      }

      const series: DebtPoint[] = [];
      if (carry) {
        series.push({ t: t0, debt: carry.debt });
      }
      for (let i = startIdx; i < pts.length; i++) {
        const p = pts[i];
        if (p.t > t1) break;
        if (p.t < t0) continue;
        series.push({ ...p });
      }

      if (live != null) {
        if (series.length === 0) {
          series.push({ t: t0, debt: live });
          series.push({ t: t1, debt: live });
        } else {
          const last = series[series.length - 1];
          if (last.t < t1) {
            series.push({ t: t1, debt: live });
          } else {
            last.debt = live;
          }
        }
      }

      const drawn = dedupeByTime(series);

      if (drawn.length === 0) {
        raf = requestAnimationFrame(frame);
        return;
      }

      let lo = 0;
      let hi = 0;
      for (const p of drawn) {
        hi = Math.max(hi, p.debt);
      }
      if (hi <= 0) hi = 1;
      hi *= 1.12;

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

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = LINE;
      ctx.lineJoin = "round";
      ctx.lineCap = "butt";
      let started = false;
      let prevX = 0;
      let prevY = 0;
      for (let i = 0; i < drawn.length; i++) {
        const p = drawn[i];
        const x = xOf(p.t);
        const y = yOf(p.debt);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
          prevX = x;
          prevY = y;
          continue;
        }
        if (x > prevX) {
          ctx.lineTo(x, prevY);
        }
        if (y !== prevY) {
          ctx.lineTo(x, y);
        }
        prevX = x;
        prevY = y;
      }
      const right = PAD.left + plotW;
      if (started && prevX < right) {
        ctx.lineTo(right, prevY);
      }
      ctx.stroke();
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
    <div ref={wrapRef} className="house-oi-curve">
      <canvas ref={canvasRef} />
    </div>
  );
}
