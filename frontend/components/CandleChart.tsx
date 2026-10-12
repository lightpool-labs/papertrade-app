"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Market } from "@/lib/api";
import {
  fetchHlCandleSnapshot,
  hlCoinFromSymbol,
  subscribeHlCandles,
  type ChartInterval,
  type HlBar,
} from "@/lib/hlCandles";

const UP = "#0ecb81";
const DOWN = "#f6465d";
const VOL_UP = "rgba(14, 203, 129, 0.45)";
const VOL_DOWN = "rgba(246, 70, 93, 0.45)";

type Props = {
  market: Market | null;
  interval: ChartInterval;
};

function toCandle(bar: HlBar): CandlestickData<UTCTimestamp> {
  return {
    time: bar.time as UTCTimestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function toVolume(bar: HlBar): HistogramData<UTCTimestamp> {
  return {
    time: bar.time as UTCTimestamp,
    value: bar.volume,
    color: bar.close >= bar.open ? VOL_UP : VOL_DOWN,
  };
}

/**
 * HL candlesticks. Snapshot + WS talk to Hyperliquid from the browser.
 * Interval is chosen by the header dropdown (shared with Tick).
 */
export function CandleChart({ market, interval }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#8b93a1",
      },
      grid: {
        vertLines: { color: "rgba(139, 147, 161, 0.14)" },
        horzLines: { color: "rgba(139, 147, 161, 0.14)" },
      },
      rightPriceScale: {
        borderColor: "#e2e5ea",
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        rightOffset: 4,
      },
      crosshair: { mode: 0 },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    series.priceScale().applyOptions({
      scaleMargins: { top: 0.06, bottom: 0.22 },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      borderVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    const ro = new ResizeObserver(() => {
      if (!wrapRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: wrapRef.current.clientWidth,
        height: wrapRef.current.clientHeight,
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!series || !volume || !chart) return;

    const symbol = market?.hl_symbol?.trim();
    if (!symbol) {
      series.setData([]);
      volume.setData([]);
      setStatus("Select a market");
      setError(null);
      return;
    }

    const coin = hlCoinFromSymbol(symbol);
    let cancelled = false;
    let unsub: (() => void) | null = null;

    setError(null);
    setStatus(`Loading ${coin} ${interval}…`);
    series.setData([]);
    volume.setData([]);

    void (async () => {
      try {
        const bars = await fetchHlCandleSnapshot(coin, interval, 300);
        if (cancelled) return;
        series.setData(bars.map(toCandle));
        volume.setData(bars.map(toVolume));
        chart.timeScale().fitContent();
        setStatus(`${coin} · Hyperliquid · ${interval}`);

        unsub = subscribeHlCandles(coin, interval, {
          onBar: (bar) => {
            if (cancelled) return;
            series.update(toCandle(bar));
            volume.update(toVolume(bar));
          },
          onStatus: (ok) => {
            if (cancelled) return;
            setStatus(
              ok
                ? `${coin} · Hyperliquid · ${interval}`
                : `${coin} · reconnecting…`,
            );
          },
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load candles");
        setStatus("Candle feed error");
      }
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [market?.hl_symbol, interval]);

  return (
    <div className="candle-chart">
      {(error || status) && (
        <div className="candle-status-bar">{error ?? status}</div>
      )}
      <div ref={wrapRef} className="candle-canvas" />
    </div>
  );
}
