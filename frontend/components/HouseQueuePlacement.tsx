"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperQueuePlacement } from "@/lib/api";
import { formatUsd, parseAmount } from "@/lib/math";

type Props = {
  placement: PaperQueuePlacement | null;
  connected: boolean;
};

const AHEAD = "#8b93a1";
const YOURS = "#f0b90b";
const BEHIND = "#3d4450";
const EMPTY_RING = "#d1d5db";

function ringSegments(ahead: number, yours: number, behind: number) {
  const total = ahead + yours + behind;
  if (total <= 0) {
    return [];
  }
  return [
    { color: AHEAD, frac: ahead / total },
    { color: YOURS, frac: yours / total },
    { color: BEHIND, frac: behind / total },
  ].filter((s) => s.frac > 0);
}

/** Stadium / 400m-track outline sized to the given box. */
function trackPath(width: number, height: number, stroke: number): string {
  const pad = stroke / 2 + 1;
  const innerH = Math.max(stroke + 4, height - 2);
  const r = Math.max(4, (innerH - stroke) / 2 - 1);
  const left = pad + r;
  const right = Math.max(left + 1, width - pad - r);
  const top = pad;
  const bottom = height - pad;
  return [
    `M ${left} ${top}`,
    `L ${right} ${top}`,
    `A ${r} ${r} 0 0 1 ${right} ${bottom}`,
    `L ${left} ${bottom}`,
    `A ${r} ${r} 0 0 1 ${left} ${top}`,
  ].join(" ");
}

export function HouseQueuePlacement({ placement, connected }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 640, h: 180 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.max(120, Math.floor(el.clientWidth));
      const h = Math.max(80, Math.floor(el.clientHeight));
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ahead = placement ? parseAmount(placement.ahead) : 0;
  const yours = placement ? parseAmount(placement.yours) : 0;
  const behind = placement ? parseAmount(placement.behind) : 0;
  const aheadN = Number.isFinite(ahead) ? ahead : 0;
  const yoursN = Number.isFinite(yours) ? yours : 0;
  const behindN = Number.isFinite(behind) ? behind : 0;
  const isEmpty = aheadN + yoursN + behindN <= 0;
  const segments = useMemo(
    () => ringSegments(aheadN, yoursN, behindN),
    [aheadN, yoursN, behindN],
  );

  const stroke = Math.max(14, Math.min(28, Math.round(box.h * 0.12)));
  const d = trackPath(box.w, box.h, stroke);

  let offset = 0;
  const arcs = segments.map((seg) => {
    const start = offset;
    offset += seg.frac;
    return {
      ...seg,
      dash: `${seg.frac} ${1 - seg.frac}`,
      dashOffset: -start,
    };
  });

  const moneyOrDash = (n: number) =>
    connected && placement ? `$${formatUsd(Number.isFinite(n) ? n : 0, 0)}` : "—";

  const centerLabel = !connected
    ? "Connect wallet"
    : placement?.in_queue
      ? `$${formatUsd(yours, 0)}`
      : "Not in queue";

  return (
    <div className="house-queue-placement-wrap">
      <div className="house-oi-chart-head">
        <h2>Queue Placement</h2>
        <div className="house-queue-placement-legend">
          <span>
            <span className="house-queue-dot ahead" />
            Ahead <strong>{moneyOrDash(ahead)}</strong>
          </span>
          <span>
            <span className="house-queue-dot yours" />
            Yours <strong>{moneyOrDash(yours)}</strong>
          </span>
          <span>
            <span className="house-queue-dot behind" />
            Behind <strong>{moneyOrDash(behind)}</strong>
          </span>
        </div>
      </div>
      <div ref={boxRef} className="house-queue-track-box">
        <svg
          className="house-queue-ring"
          width={box.w}
          height={box.h}
          viewBox={`0 0 ${box.w} ${box.h}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d={d}
            fill="none"
            stroke={isEmpty ? EMPTY_RING : "rgba(139,147,161,0.18)"}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeLinejoin="round"
            pathLength={1}
          />
          {arcs.map((arc, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={arc.color}
              strokeWidth={stroke}
              strokeLinecap="butt"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={arc.dash}
              strokeDashoffset={arc.dashOffset}
            />
          ))}
          <text
            x={box.w / 2}
            y={box.h / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            className="house-queue-ring-label"
          >
            {centerLabel}
          </text>
        </svg>
      </div>
    </div>
  );
}
