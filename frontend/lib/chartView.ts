import type { ChartInterval } from "@/lib/hlCandles";

export type ChartView = "tick" | ChartInterval;

export const CHART_VIEWS: { value: ChartView; label: string }[] = [
  { value: "tick", label: "Tick" },
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "1h", label: "1h" },
  { value: "1d", label: "1d" },
];

export function isCandleInterval(view: ChartView): view is ChartInterval {
  return view !== "tick";
}
