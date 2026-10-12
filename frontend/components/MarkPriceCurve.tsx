"use client";

import { useEffect, useRef } from "react";
import { formatPrice } from "@/lib/math";

type Point = { t: number; p: number };

type Props = {
  mark: number | null;
  /** Visible time window in ms (default 30s). */
  windowMs?: number;
};

const PAD = { top: 16, right: 72, bottom: 28, left: 12 };
const BUY = "#0ecb81";
const SELL = "#f6465d";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";
const CHASE = 28;
const TIME_STEP_MS = 5_000;
const SAMPLE_MS = 80;

/**
 * Live mark-price running curve (not candles).
 * History is kept forever. Left-drag pans; after release the window keeps
 * scrolling right→left at normal wall-clock speed (optional delay via pan).
 */
export function MarkPriceCurve({ mark, windowMs = 30_000 }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const displayRef = useRef<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const sessionOpenRef = useRef<number | null>(null);
  /** How far the right edge sits behind live now (ms). Always scrolls with time. */
  const panBackMsRef = useRef(0);
  const draggingRef = useRef(false);
  const lastDragXRef = useRef(0);

  useEffect(() => {
    if (mark == null || !Number.isFinite(mark) || mark <= 0) return;
    const now = Date.now();
    targetRef.current = mark;
    if (displayRef.current == null) {
      displayRef.current = mark;
      sessionOpenRef.current = mark;
      pointsRef.current = [{ t: now, p: mark }];
      panBackMsRef.current = 0;
      return;
    }
    const last = pointsRef.current[pointsRef.current.length - 1];
    if (!last || last.p !== mark || now - last.t >= SAMPLE_MS) {
      pointsRef.current.push({ t: now, p: mark });
    }
  }, [mark]);

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

    const clampPanBack = (value: number) => {
      const now = Date.now();
      const pts = pointsRef.current;
      const oldest = pts.length > 0 ? pts[0].t : now;
      const maxBack = Math.max(0, now - oldest);
      return Math.min(Math.max(0, value), maxBack);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      draggingRef.current = true;
      lastDragXRef.current = e.clientX;
      wrap.classList.add("panning");
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const rect = wrap.getBoundingClientRect();
      const plotW = Math.max(1, rect.width - PAD.left - PAD.right);
      const dx = e.clientX - lastDragXRef.current;
      lastDragXRef.current = e.clientX;
      // Drag right → older history; drag left → toward live.
      // After release, panBack stays and the window keeps scrolling with time.
      panBackMsRef.current = clampPanBack(
        panBackMsRef.current + (dx / plotW) * windowMs,
      );
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 && !draggingRef.current) return;
      draggingRef.current = false;
      wrap.classList.remove("panning");
    };

    canvas.addEventListener("mousedown", onMouseDown);
    wrap.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    const easeToward = (from: number, to: number, dt: number) => {
      const alpha = 1 - Math.exp(-dt * CHASE);
      return from + (to - from) * alpha;
    };

    let prevFrame = performance.now();

    const frame = (frameTs: number) => {
      if (!alive) return;
      const dt = Math.min(0.05, (frameTs - prevFrame) / 1000);
      prevFrame = frameTs;
      const now = Date.now();

      const target = targetRef.current;
      if (target != null) {
        const cur = displayRef.current ?? target;
        displayRef.current = easeToward(cur, target, dt);
      }

      const display = displayRef.current;
      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (display == null) {
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for mark…", W / 2, H / 2);
        raf = requestAnimationFrame(frame);
        return;
      }

      const pts = pointsRef.current;
      const last = pts[pts.length - 1];
      if (!last || now - last.t >= SAMPLE_MS) {
        pts.push({ t: now, p: display });
      }

      // Always scroll with wall clock — pan only shifts how far behind live.
      const panBack = clampPanBack(panBackMsRef.current);
      panBackMsRef.current = panBack;
      const atLive = panBack < 40;
      const t1 = now - panBack;
      const t0 = t1 - windowMs;

      const visible: Point[] = [];
      let startIdx = 0;
      while (startIdx < pts.length && pts[startIdx].t < t0) startIdx++;
      if (startIdx > 0) startIdx--;
      for (let i = startIdx; i < pts.length; i++) {
        const p = pts[i];
        visible.push(p);
        if (p.t > t1) break;
      }
      if (atLive && (visible.length === 0 || visible[visible.length - 1].t < now)) {
        visible.push({ t: now, p: display });
      }
      if (visible.length === 0 && pts.length > 0) {
        visible.push(pts[Math.min(startIdx, pts.length - 1)]);
      }

      let lo = Infinity;
      let hi = -Infinity;
      for (const p of visible) {
        if (p.t < t0 || p.t > t1) continue;
        if (p.p < lo) lo = p.p;
        if (p.p > hi) hi = p.p;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = display * 0.999;
        hi = display * 1.001;
      }
      const mid = (lo + hi) / 2;
      let span = Math.max(hi - lo, mid * 0.0008, 1);
      lo = mid - span * 0.65;
      hi = mid + span * 0.65;
      span = hi - lo;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const xOf = (t: number) =>
        PAD.left + ((t - t0) / (t1 - t0)) * plotW;
      const yOf = (p: number) =>
        PAD.top + ((hi - p) / span) * plotH;

      const open = sessionOpenRef.current ?? display;
      const tipPrice = atLive
        ? display
        : visible[visible.length - 1]?.p ?? display;
      const up = tipPrice >= open;
      const stroke = up ? BUY : SELL;
      const fillTop = up ? "rgba(14, 203, 129, 0.18)" : "rgba(246, 70, 93, 0.16)";

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();

      if (visible.length >= 2) {
        const baseY = yOf(lo);
        const grad = ctx.createLinearGradient(0, PAD.top, 0, H - PAD.bottom);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath();
        ctx.moveTo(xOf(visible[0].t), baseY);
        for (const p of visible) ctx.lineTo(xOf(p.t), yOf(p.p));
        ctx.lineTo(xOf(visible[visible.length - 1].t), baseY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let i = 0; i < visible.length; i++) {
        const x = xOf(visible[i].t);
        const y = yOf(visible[i].p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const v = hi - (span * i) / 4;
        const y = yOf(v);
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(W - PAD.right, y);
        ctx.stroke();
        ctx.fillStyle = MUTED;
        ctx.fillText(`$${formatPrice(v)}`, W - PAD.right + 8, y);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const firstTick = Math.ceil(t0 / TIME_STEP_MS) * TIME_STEP_MS;
      for (let t = firstTick; t <= t1 + 1; t += TIME_STEP_MS) {
        const x = xOf(t);
        if (x < PAD.left - 2 || x > W - PAD.right + 2) continue;
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, H - PAD.bottom);
        ctx.stroke();
        ctx.fillStyle = MUTED;
        ctx.fillText(formatLocalHms(t), x, H - PAD.bottom + 8);
      }

      if (atLive) {
        const tipX = xOf(now);
        const tipY = yOf(display);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(139, 147, 161, 0.55)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.left, tipY);
        ctx.lineTo(W - PAD.right, tipY);
        ctx.stroke();
        ctx.setLineDash([]);

        const pulse = 0.55 + 0.45 * Math.sin(frameTs / 280);
        ctx.beginPath();
        ctx.arc(tipX, tipY, 8 + pulse * 3, 0, Math.PI * 2);
        ctx.fillStyle = up
          ? `rgba(14, 203, 129, ${0.12 + pulse * 0.1})`
          : `rgba(246, 70, 93, ${0.12 + pulse * 0.1})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(tipX, tipY, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = stroke;
        ctx.fill();

        const label = `$${formatPrice(display)}`;
        ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        const chipX = W - PAD.right + 4;
        const chipY = tipY - 10;
        ctx.fillStyle = stroke;
        roundRect(ctx, chipX, chipY, tw + 12, 20, 4);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, chipX + 6, tipY);
      } else {
        ctx.fillStyle = MUTED;
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("live →  (left-drag)", W - PAD.right - 6, PAD.top + 4);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousedown", onMouseDown);
      wrap.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      wrap.classList.remove("panning");
    };
  }, [windowMs]);

  useEffect(() => {
    if (mark == null) {
      pointsRef.current = [];
      displayRef.current = null;
      targetRef.current = null;
      sessionOpenRef.current = null;
      panBackMsRef.current = 0;
    }
  }, [mark]);

  return (
    <div ref={wrapRef} className="mark-curve">
      <canvas ref={canvasRef} className="mark-curve-canvas" />
    </div>
  );
}

function formatLocalHms(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
