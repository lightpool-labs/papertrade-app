"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperPositionHistory, PaperPositionOpen } from "@/lib/api";
import {
  DEMO_API,
  buildDemoLongs,
  demoConfigured,
  demoLiqHistory,
  demoUrl,
  emitDemoChip,
  fetchDemoSession,
  fetchDemoTimeline,
  type DemoEvent,
  type DemoMark,
  type DemoSession,
  type DemoTimeline,
} from "@/lib/demo";
import { changePctVsPrevDay } from "@/lib/hlDayChange";
import { POS_LIQD_EVENT, launchLiqdAsh } from "@/lib/liqdFireworks";
import { priceCurveXSpan } from "@/lib/priceCurveHit";

export type DemoStatus = "idle" | "loading" | "ready" | "error";

export type DemoPlayer = {
  active: boolean;
  status: DemoStatus;
  error: string | null;
  session: DemoSession | null;
  timeline: DemoTimeline | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Bumped on every seek so the curve can drop stale history. */
  seekSeq: number;
  openPositions: PaperPositionOpen[];
  history: PaperPositionHistory[];
  mark: number | null;
  changePct: number | null;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  jumpToClimax: () => void;
};

const MARK_PUSH_S = 0.045;
const CHIP_MIN_GAP_MS = 120;
const DEMO_LIQ_HOLD_MS = 1100;

function lowerBoundEvents(events: DemoEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function markAt(marks: DemoMark[], t: number): number | null {
  if (marks.length === 0) return null;
  if (t <= marks[0].t) return marks[0].px;
  let lo = 0;
  let hi = marks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (marks[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = marks[lo];
  const b = marks[Math.min(lo + 1, marks.length - 1)];
  if (b.t <= a.t) return a.px;
  const u = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  return a.px + (b.px - a.px) * u;
}

function fakeWallet(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `0xdemo${h.toString(16).padStart(8, "0")}`;
}

export function useDemoPlayer(
  sessionId: string | null,
  owner: string | null,
): DemoPlayer {
  const active = sessionId != null && sessionId.trim().length > 0;
  const [status, setStatus] = useState<DemoStatus>(active ? "loading" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [timeline, setTimeline] = useState<DemoTimeline | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seekSeq, setSeekSeq] = useState(0);
  const [openPositions, setOpenPositions] = useState<PaperPositionOpen[]>([]);
  const [history, setHistory] = useState<PaperPositionHistory[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [mark, setMark] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const marksRef = useRef<DemoMark[]>([]);
  const eventsRef = useRef<DemoEvent[]>([]);
  const eventIdxRef = useRef(0);
  /** Bumped per seek so replayed liqs bypass the fireworks id dedupe. */
  const passRef = useRef(0);
  const lastMarkPushRef = useRef(-1);
  const lastChipMsRef = useRef(0);
  const baselineRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const longsRef = useRef<PaperPositionOpen[]>([]);
  const bustedRef = useRef<Set<number>>(new Set());
  const bookGenRef = useRef(0);

  const publishBook = useCallback(() => {
    const rows = longsRef.current;
    const busted = bustedRef.current;
    setOpenPositions(rows.filter((row) => !busted.has(row.position)));
    setHistory(
      rows.filter((row) => busted.has(row.position)).map(demoLiqHistory),
    );
  }, []);

  const armLongs = useCallback((anchor: number) => {
    anchorRef.current = anchor;
    bustedRef.current = new Set();
    longsRef.current = buildDemoLongs(anchor, ownerRef.current);
    publishBook();
  }, [publishBook]);

  const bustLong = useCallback((row: PaperPositionOpen) => {
    const span = priceCurveXSpan();
    const fromLeft = Math.min(
      1,
      Math.max(0, 1 - Math.log10(Math.max(Number(row.margin), 1)) / 3.75),
    );
    const x = span
      ? span.x0 + fromLeft * (span.x1 - span.x0)
      : window.innerWidth * 0.6;
    const banner = document.querySelector(".house-activity-banner");
    const rect = banner?.getBoundingClientRect();
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight - 28;
    launchLiqdAsh(
      x,
      y,
      Number(row.margin),
      `demo-long-${row.position}#${passRef.current}`,
    );
    window.dispatchEvent(
      new CustomEvent(POS_LIQD_EVENT, {
        detail: { market: row.market, position: row.position },
      }),
    );
  }, []);

  const reconcileLongs = useCallback((px: number, animate: boolean) => {
    const rows = longsRef.current;
    if (rows.length === 0 || !Number.isFinite(px)) return;
    const gen = bookGenRef.current;
    let armed = false;
    for (const row of rows) {
      if (bustedRef.current.has(row.position)) continue;
      const bust = Number(row.bust_price);
      if (!(px <= bust)) continue;
      bustedRef.current.add(row.position);
      if (!animate) continue;
      armed = true;
      bustLong(row);
    }
    if (!animate) {
      publishBook();
      return;
    }
    if (!armed) return;
    window.setTimeout(() => {
      if (bookGenRef.current !== gen) return;
      publishBook();
    }, DEMO_LIQ_HOLD_MS);
  }, [bustLong, publishBook]);

  const pushMark = useCallback((t: number, force: boolean, animateBust: boolean) => {
    const px = markAt(marksRef.current, t);
    if (px == null) return;
    if (!force && t - lastMarkPushRef.current < MARK_PUSH_S) return;
    lastMarkPushRef.current = t;
    setMark(px);
    setCurrentTime(t);
    setChangePct(changePctVsPrevDay(px, baselineRef.current));
    reconcileLongs(px, animateBust);
  }, [reconcileLongs]);

  const fireEvent = useCallback((ev: DemoEvent) => {
    const uid = `${ev.id}#${passRef.current}`;
    const scaled = Math.round(ev.amount_usd * 1_000_000);

    if (ev.kind === "liq") {
      const span = priceCurveXSpan();
      const fromLeft = Math.min(
        1,
        Math.max(0, 1 - Math.log10(Math.max(ev.amount_usd, 1)) / 3.75),
      );
      const x = span
        ? span.x0 + fromLeft * (span.x1 - span.x0)
        : window.innerWidth * 0.6;
      const banner = document.querySelector(".house-activity-banner");
      const rect = banner?.getBoundingClientRect();
      const y = rect ? rect.top + rect.height / 2 : window.innerHeight - 28;
      launchLiqdAsh(x, y, ev.amount_usd, uid);

      const nowMs = performance.now();
      if (nowMs - lastChipMsRef.current >= CHIP_MIN_GAP_MS) {
        lastChipMsRef.current = nowMs;
        emitDemoChip({
          event: "liquidated",
          instrument_name: ev.asset,
          is_long: ev.side === "long",
          margin_raw: scaled,
          pnl_raw: -scaled,
          user_address: fakeWallet(ev.id),
          demo_id: uid,
        });
      }
      return;
    }

    emitDemoChip({
      event: ev.kind === "open" ? "opened" : "closed",
      instrument_name: ev.asset,
      is_long: ev.side === "long",
      margin_raw: scaled,
      pnl_raw:
        ev.kind === "close" && ev.pnl_usd != null
          ? Math.round(ev.pnl_usd * 1_000_000)
          : undefined,
      user_address: fakeWallet(ev.id),
      demo_id: uid,
    });
  }, []);

  useEffect(() => {
    if (!active) {
      setStatus("idle");
      setSession(null);
      setTimeline(null);
      setError(null);
      setMark(null);
      setChangePct(null);
      setCurrentTime(0);
      setPlaying(false);
      setSeekSeq(0);
      bookGenRef.current += 1;
      setOpenPositions([]);
      setHistory([]);
      longsRef.current = [];
      bustedRef.current = new Set();
      anchorRef.current = null;
      return;
    }
    const id = sessionId.trim();
    if (!demoConfigured()) {
      setStatus("error");
      setError("demo API not configured (set NEXT_PUBLIC_DEMO_API)");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setSession(null);
    setTimeline(null);
    setMark(null);
    setChangePct(null);
    setCurrentTime(0);
    setPlaying(false);
    setSeekSeq(0);
    setOpenPositions([]);
    setHistory([]);
    longsRef.current = [];
    bustedRef.current = new Set();
    anchorRef.current = null;
    marksRef.current = [];
    eventsRef.current = [];
    eventIdxRef.current = 0;
    passRef.current = 0;
    lastMarkPushRef.current = -1;
    baselineRef.current = null;

    const load = async () => {
      try {
        const meta = await fetchDemoSession(id);
        const tl = await fetchDemoTimeline(id);
        if (cancelled) return;
        const marks = [...tl.marks].sort((a, b) => a.t - b.t);
        const events = [...tl.events].sort((a, b) => a.t - b.t);
        marksRef.current = marks;
        eventsRef.current = events;
        baselineRef.current = marks.length > 0 ? marks[0].px : null;
        if (marks.length > 0) armLongs(marks[0].px);

        const audio = new Audio(demoUrl(meta.song_url));
        audio.preload = "auto";
        audio.addEventListener("play", () => setPlaying(true));
        audio.addEventListener("pause", () => setPlaying(false));
        audio.addEventListener("ended", () => setPlaying(false));
        audioRef.current = audio;

        setSession(meta);
        setTimeline({ ...tl, marks, events });
        setStatus("ready");
        pushMark(0, true, false);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "failed to load demo");
      }
    };
    void load();

    return () => {
      cancelled = true;
      bookGenRef.current += 1;
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      audioRef.current = null;
    };
  }, [active, sessionId, pushMark, armLongs]);

  useEffect(() => {
    if (status !== "ready") return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      const ct = audio.currentTime;
      pushMark(ct, false, true);
      const events = eventsRef.current;
      while (
        eventIdxRef.current < events.length &&
        events[eventIdxRef.current].t <= ct
      ) {
        fireEvent(events[eventIdxRef.current]);
        eventIdxRef.current += 1;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [status, pushMark, fireEvent]);

  const seek = useCallback(
    (t: number) => {
      const audio = audioRef.current;
      const target = Math.max(0, t);
      passRef.current += 1;
      bookGenRef.current += 1;
      setSeekSeq((s) => s + 1);
      eventIdxRef.current = lowerBoundEvents(eventsRef.current, target);
      const anchor = anchorRef.current;
      if (anchor != null) {
        bustedRef.current = new Set();
        longsRef.current = buildDemoLongs(anchor, ownerRef.current);
      }
      if (audio) audio.currentTime = target;
      pushMark(target, true, false);
    },
    [pushMark],
  );

  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor == null) return;
    const busted = new Set(bustedRef.current);
    longsRef.current = buildDemoLongs(anchor, owner);
    bustedRef.current = busted;
    publishBook();
  }, [owner, publishBook]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.ended) seek(0);
    void audio.play().catch(() => setPlaying(false));
  }, [seek]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const jumpToClimax = useCallback(() => {
    const climax = session?.climax_at;
    if (climax == null) return;
    seek(Math.max(0, climax - 2));
    const audio = audioRef.current;
    if (audio) void audio.play().catch(() => setPlaying(false));
  }, [session, seek]);

  return {
    active,
    status,
    error,
    session,
    timeline,
    playing,
    currentTime,
    duration: session?.duration ?? 0,
    seekSeq,
    openPositions,
    history,
    mark,
    changePct,
    play,
    pause,
    seek,
    jumpToClimax,
  };
}

export { DEMO_API };
