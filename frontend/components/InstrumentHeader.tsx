"use client";

import Link from "next/link";
import type { Market } from "@/lib/api";
import { CHART_VIEWS, type ChartView } from "@/lib/chartView";
import { formatPrice } from "@/lib/math";

type Props = {
  markets: Market[];
  selected: Market | null;
  mark: number | null;
  changePct: number | null;
  chartView: ChartView;
  onChartViewChange: (view: ChartView) => void;
};

export function InstrumentHeader({
  markets,
  selected,
  mark,
  changePct,
  chartView,
  onChartViewChange,
}: Props) {
  const up = changePct != null && changePct >= 0;
  const changeClass =
    changePct == null ? "mark-change flat" : up ? "mark-change up" : "mark-change down";
  const changeLabel =
    changePct == null
      ? "—"
      : `${up ? "+" : ""}${changePct.toFixed(2)}%`;

  return (
    <div className="instrument-header">
      <div className="instrument-left">
        <div className="instrument-switcher">
          {markets.map((market) => (
            <Link
              key={market.slug}
              href={`/trade/${market.slug}`}
              className={`instrument-chip${selected?.slug === market.slug ? " active" : ""}`}
            >
              {market.name}
            </Link>
          ))}
        </div>
        <div className="instrument-quote">
          <span className="mark-price">
            {mark !== null ? `$${formatPrice(mark)}` : "—"}
          </span>
          <span className={changeClass}>{changeLabel}</span>
        </div>
      </div>
      <div className="instrument-meta">
        <select
          className="chart-view-select"
          value={chartView}
          onChange={(e) => onChartViewChange(e.target.value as ChartView)}
          aria-label="Chart view"
        >
          {CHART_VIEWS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
