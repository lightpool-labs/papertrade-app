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
const PAD = { top: 16, right: 52, bottom: 34, left: 12 };
const LINE = "#0ecb81";
const FILL = "rgba(14, 203, 129, 0.14)";
const GRID = "rgba(139, 147, 161, 0.14)";
const MUTED = "#8b93a1";
const DOT = "#f0b90b";
const THRESH = "rgba(240, 185, 11, 0.45)";
const REDRAW_MS = 1_000;

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
  if (abs >= 1_000_000_000) {
    const n = abs / 1_000_000_000;
    return `${sign}$${n >= 10 ? n.toFixed(0) : n.toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    const n = abs / 1_000_000;
    return `${sign}$${n >= 10 ? n.toFixed(0) : n.toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    const n = abs / 1_000;
    return `${sign}$${n >= 10 ? n.toFixed(0) : n.toFixed(1)}K`;
  }
  return `${sign}$${abs.toFixed(0)}`;
}

/** Round up to 1 / 2 / 5 × 10^n for readable axis ends. */
function niceCeil(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const exp = Math.floor(Math.log10(x));
  const pow = 10 ** exp;
  const frac = x / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

/** Even milestones on [0, xMax]. Prefer `preferStep` (e.g. flat $2M) when it fits. */
function niceTicks(xMax: number, preferStep = 0): number[] {
  if (!(xMax > 0)) return [0];
  let step = niceCeil(xMax / 4);
  if (preferStep > 0) {
    const n = xMax / preferStep;
    if (n >= 2 && n <= 8) step = preferStep;
  }
  const out: number[] = [];
  for (let v = 0; v <= xMax + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  const last = out[out.length - 1];
  if (last < xMax * 0.92) out.push(xMax);
  else if (Math.abs(last - xMax) > step * 1e-6) out[out.length - 1] = xMax;
  return out;
}

/** Fixed chart window: Tracked LP $0 … $10M. */
const X_MIN_USD = 0;
const X_MAX_USD = 10_000_000;

function rateLabel(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  if (rate >= 100) return `${rate.toFixed(0)} PAPER/$`;
  if (rate >= 10) return `${rate.toFixed(1)} PAPER/$`;
  return `${rate.toFixed(2)} PAPER/$`;
}

type Props = {
  params: PaperMintCurveParams | null;
};

type HitLayout = {
  xMin: number;
  xMax: number;
  plotLeft: number;
  plotW: number;
  flatThreshold: number;
  flatRatePpm: number;
  tailDecayScale: number;
  trackedLp: number;
  tailHwm: number;
};

export function PaperRewardCurve({ params }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const paramsRef = useRef(params);
  const drawRef = useRef<() => void>(() => {});
  const lastDrawRef = useRef(0);
  const timerRef = useRef(0);
  const hitRef = useRef<HitLayout | null>(null);
  const hoverXRef = useRef<number | null>(null);

  useEffect(() => {
    paramsRef.current = params;
    const now = Date.now();
    const wait = Math.max(0, REDRAW_MS - (now - lastDrawRef.current));
    if (timerRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      lastDrawRef.current = Date.now();
      drawRef.current();
    }, wait);
  }, [params]);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    if (!wrap || !canvas || !tip) return;
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

    const placeTip = (clientX: number, clientY: number, html: string) => {
      tip.innerHTML = html;
      tip.hidden = false;
      const tipW = Math.max(tip.offsetWidth, 140);
      const tipH = Math.max(tip.offsetHeight, 48);
      let left = clientX + 14;
      let top = clientY + 16;
      if (left + tipW > window.innerWidth - 8) left = clientX - tipW - 14;
      if (top + tipH > window.innerHeight - 8) top = clientY - tipH - 10;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const hideTip = () => {
      tip.hidden = true;
      tip.innerHTML = "";
      hoverXRef.current = null;
      drawRef.current();
    };

    const draw = () => {
      const p = paramsRef.current;
      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      ctx.clearRect(0, 0, W, H);

      if (!p || p.flatRatePpm <= 0) {
        hitRef.current = null;
        ctx.fillStyle = MUTED;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for mint curve params…", W / 2, H / 2);
        return;
      }

      const flatUsd = Math.max(0, p.flatThreshold / PAPER_PPM);
      const liveLpUsd = p.trackedLp / PAPER_PPM;
      const flatRate = p.flatRatePpm / PAPER_PPM;

      const xMin = X_MIN_USD;
      const xMax = X_MAX_USD;
      const xSpan = xMax - xMin;
      const yMax = flatRate * 1.08;

      const plotW = W - PAD.left - PAD.right;
      const plotH = H - PAD.top - PAD.bottom;
      const xOf = (lpUsd: number) =>
        PAD.left + ((Math.min(xMax, Math.max(xMin, lpUsd)) - xMin) / xSpan) * plotW;
      const yOf = (rate: number) =>
        PAD.top + ((yMax - rate) / yMax) * plotH;

      hitRef.current = {
        xMin,
        xMax,
        plotLeft: PAD.left,
        plotW,
        flatThreshold: p.flatThreshold,
        flatRatePpm: p.flatRatePpm,
        tailDecayScale: p.tailDecayScale,
        trackedLp: p.trackedLp,
        tailHwm: p.tailHwm,
      };

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
        const yLab =
          i === 0 ? `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} PAPER/$` : v >= 10 ? v.toFixed(0) : v.toFixed(1);
        ctx.fillText(yLab, PAD.left + plotW + 6, y);
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
        ctx.fillText(`flat @ ${axisUsd(flatUsd)}`, tx, PAD.top + 2);
      }

      const steps = 120;
      const poly: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const lpUsd = xMin + (xSpan * i) / steps;
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

      // Live marker on the curve; label = mint rate; above/below by room on Y.
      const liveOnCurve = theoreticalRate(
        p.trackedLp,
        p.flatThreshold,
        p.flatRatePpm,
        p.tailDecayScale,
      );
      const lx = xOf(liveLpUsd);
      const ly = yOf(liveOnCurve);
      if (
        liveLpUsd >= xMin &&
        liveLpUsd <= xMax &&
        lx >= PAD.left &&
        lx <= PAD.left + plotW
      ) {
        ctx.fillStyle = DOT;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#0b0e11";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const label = rateLabel(liveOnCurve);
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        const padX = 5;
        const padY = 3;
        const labelW = ctx.measureText(label).width;
        const boxW = labelW + padX * 2;
        const boxH = 10 + padY * 2;
        const roomAbove = ly - PAD.top;
        const roomBelow = PAD.top + plotH - ly;
        const placeBelow = roomAbove < boxH + 10 || roomBelow >= roomAbove;
        let boxX = lx - boxW / 2;
        boxX = Math.max(PAD.left + 2, Math.min(boxX, PAD.left + plotW - boxW - 2));
        let boxY = placeBelow ? ly + 8 : ly - 8 - boxH;
        boxY = Math.max(PAD.top + 2, Math.min(boxY, PAD.top + plotH - boxH - 2));
        ctx.fillStyle = "#f5f6f8";
        ctx.strokeStyle = "#9aa3af";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#1a1d24";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, boxX + padX, boxY + boxH / 2);
      }

      const hoverX = hoverXRef.current;
      if (hoverX != null && hoverX >= PAD.left && hoverX <= PAD.left + plotW) {
        const lpUsd = xMin + ((hoverX - PAD.left) / plotW) * xSpan;
        const rate = theoreticalRate(
          lpUsd * PAPER_PPM,
          p.flatThreshold,
          p.flatRatePpm,
          p.tailDecayScale,
        );
        const hx = xOf(lpUsd);
        const hy = yOf(rate);
        ctx.strokeStyle = "rgba(139, 147, 161, 0.55)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, PAD.top);
        ctx.lineTo(hx, PAD.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = LINE;
        ctx.beginPath();
        ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      ctx.fillStyle = MUTED;
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (const lpUsd of niceTicks(xMax, flatUsd)) {
        ctx.fillText(axisUsd(lpUsd), xOf(lpUsd), H - 16);
      }
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("Tracked LP (USDC) →", PAD.left + plotW / 2, H - 4);
    };

    const onMove = (e: MouseEvent) => {
      const hit = hitRef.current;
      if (!hit) {
        hideTip();
        return;
      }
      const wr = wrap.getBoundingClientRect();
      const x = e.clientX - wr.left;
      if (x < hit.plotLeft || x > hit.plotLeft + hit.plotW) {
        hideTip();
        return;
      }
      hoverXRef.current = x;
      const lpUsd =
        hit.xMin + ((x - hit.plotLeft) / hit.plotW) * (hit.xMax - hit.xMin);
      const rate = theoreticalRate(
        lpUsd * PAPER_PPM,
        hit.flatThreshold,
        hit.flatRatePpm,
        hit.tailDecayScale,
      );
      placeTip(
        e.clientX,
        e.clientY,
        `<div class="paper-chart-tip-title">Reward curve</div>
         <div class="paper-chart-tip-row"><span>Tracked LP</span><strong>${axisUsd(lpUsd)}</strong></div>
         <div class="paper-chart-tip-row"><span>Mint rate</span><strong>${rateLabel(rate)}</strong></div>`,
      );
      draw();
    };

    drawRef.current = draw;
    resize();
    draw();
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap);
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", hideTip);

    return () => {
      drawRef.current = () => {};
      ro.disconnect();
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", hideTip);
    };
  }, []);

  return (
    <div ref={wrapRef} className="house-oi-curve paper-reward-curve paper-chart-hover">
      <canvas ref={canvasRef} />
      <div ref={tipRef} className="paper-chart-tip" hidden />
    </div>
  );
}
