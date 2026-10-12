"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeHlTrades } from "@/lib/hlTrades";

export type HlPriceState = {
  price: number | null;
  prevPrice: number | null;
  changePct: number | null;
  connected: boolean;
  updatedAt: number | null;
};

export function useHlTradePrice(coin: string | null | undefined): HlPriceState {
  const [price, setPrice] = useState<number | null>(null);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const sessionOpenRef = useRef<number | null>(null);

  useEffect(() => {
    setPrice(null);
    setPrevPrice(null);
    setChangePct(null);
    setConnected(false);
    setUpdatedAt(null);
    sessionOpenRef.current = null;

    if (!coin) return;

    const unsubscribe = subscribeHlTrades(coin, (tick) => {
      setConnected(true);
      setPrice((current) => {
        setPrevPrice(current);
        return tick.px;
      });
      if (sessionOpenRef.current == null) {
        sessionOpenRef.current = tick.px;
      }
      const open = sessionOpenRef.current;
      if (open && open > 0) {
        setChangePct(((tick.px - open) / open) * 100);
      }
      setUpdatedAt(tick.time || Date.now());
    });

    return unsubscribe;
  }, [coin]);

  return { price, prevPrice, changePct, connected, updatedAt };
}
