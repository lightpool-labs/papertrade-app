"use client";

import { useEffect, useRef } from "react";

/** Params for the on-chain mint-rate curve (PAPER per $ loss vs tracked LP). */
export type PaperMintCurveParams = {
  flatThreshold: number;
  flatRatePpm: number;
  tailDecayScale: number;
  trackedLp: number;
  tailHwm: number;
};

const PAPER_PPM = 1_000_000;
const PAD = { top: 16, right: 48, bottom: 28, left: 12 };
const LINE = "#0ecb81";
const FILL = "rgba(14, 203, 129, 0.14)";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";
const DOT = "#f0b90b";
const THRESH = "rgba(240, 185, 11, 0.45)";

function mintRate(
  trackedLp: number,
  tailHwm: number,
  flatThreshold: number,
  flatRatePpm: number,
  tailDecayScale: number,
): number {
  if (trackedLp < flatThreshold) return flatRatePpm / PAPER_PPM;
  const s = tailDecayScale;
  if (s <= 0) return 0;
  const h = Math.max(0, tailHwm);
  return (flatRatePpm * s * s) / ((s + h) * (s + h)) / PAPER_PPM;
}

/** Theoretical rate if HWM = max(0, lp − flatThreshold) and LP only grows. */
function theoreticalRate(
  lp: number,
  flatThreshold: number,
  flatRatePpm: number,
  tailDecayScale: number,
): number {
  const h = Math.max(0, lp - flatThreshold);
  return mintRate(lp, h, flatThreshold, flatRatePpm, tailDecayScale);
}

function axisUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

type Props = {
  params: PaperMintCurveParams | null;
};

export function PaperRewardCurve({ params }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paramsRef = useRef(params);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    paramsRef.current = params;
    drawRef.current();
  }, [params]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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

    const draw = () => {
      const p = paramsRef.current;
      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (!p || p.flatRatePpm <= 0) {
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for mint curve params…", W / 2, H / 2);
        return;
      }

      const flatUsd = p.flatThreshold / PAPER_PPM;
      const scaleUsd = p.tailDecayScale / PAPER_PPM;
      const liveLpUsd = p.trackedLp / PAPER_PPM;
      const flatRate = p.flatRatePpm / PAPER_PPM;

      const xMax = Math.max(
        flatUsd * 2,
        flatUsd + scaleUsd * 1.2,
        Math.abs(liveLpUsd) * 1.15,
        1,
      );
      const yMax = flatRate * 1.08;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const xOf = (lpUsd: number) =>
        PAD.left + (Math.min(xMax, Math.max(0, lpUsd)) / xMax) * plotW;
      const yOf = (rate: number) =>
        PAD.top + ((yMax - rate) / yMax) * plotH;

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.fillStyle = MUTED;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 3; i++) {
        const y = PAD.top + (plotH * i) / 3;
        const v = yMax - (yMax * i) / 3;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + plotW, y);
        ctx.stroke();
        ctx.fillText(v >= 10 ? v.toFixed(0) : v.toFixed(1), PAD.left + plotW + 6, y);
      }

      if (flatUsd > 0 && flatUsd < xMax) {
        const tx = xOf(flatUsd);
        ctx.strokeStyle = THRESH;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(tx, PAD.top);
        ctx.lineTo(tx, PAD.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = MUTED;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`flat ${axisUsd(flatUsd)}`, tx, PAD.top + 2);
      }

      const steps = 120;
      const poly: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const lpUsd = (xMax * i) / steps;
        const rate = theoreticalRate(
          lpUsd * PAPER_PPM,
          p.flatThreshold,
          p.flatRatePpm,
          p.tailDecayScale,
        );
        poly.push({ x: xOf(lpUsd), y: yOf(rate) });
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, plotW, plotH);
      ctx.clip();

      if (poly.length >= 2) {
        const baseY = PAD.top + plotH;
        const grad = ctx.createLinearGradient(0, PAD.top, 0, baseY);
        grad.addColorStop(0, FILL);
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
        ctx.strokeStyle = LINE;
        ctx.lineJoin = "round";
        for (let i = 0; i < poly.length; i++) {
          if (i === 0) ctx.moveTo(poly[i].x, poly[i].y);
          else ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.stroke();
      }

      const liveRate = mintRate(
        p.trackedLp,
        p.tailHwm,
        p.flatThreshold,
        p.flatRatePpm,
        p.tailDecayScale,
      );
      const lx = xOf(Math.max(0, liveLpUsd));
      const ly = yOf(liveRate);
      ctx.fillStyle = DOT;
      ctx.beginPath();
      ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0b0e11";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.restore();

      ctx.fillStyle = MUTED;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (let i = 0; i <= 4; i++) {
        const lpUsd = (xMax * i) / 4;
        ctx.fillText(axisUsd(lpUsd), xOf(lpUsd), H - 8);
      }
    };

    drawRef.current = draw;
    resize();
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap);

    return () => {
      drawRef.current = () => {};
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="house-oi-curve paper-reward-curve">
      <canvas ref={canvasRef} />
    </div>
  );
}
