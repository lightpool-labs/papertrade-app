"use client";

import { useEffect, useState } from "react";
import type { DemoPlayer } from "@/hooks/useDemoPlayer";
import { demoUrl } from "@/lib/demo";

type DemoTheme = "light" | "dark";
const THEME_KEY = "paper-demo-theme";

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DemoPanel({ player }: { player: DemoPlayer }) {
  const [theme, setTheme] = useState<DemoTheme>("light");
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") setTheme(saved);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.dataset.demoTheme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme, themeReady]);

  useEffect(() => {
    return () => {
      delete document.documentElement.dataset.demoTheme;
    };
  }, []);

  const themeButtons = (
    <div className="demo-panel-themes" role="group" aria-label="Theme">
      <button
        type="button"
        className={theme === "light" ? "is-on" : ""}
        onClick={() => setTheme("light")}
      >
        Light
      </button>
      <button
        type="button"
        className={theme === "dark" ? "is-on" : ""}
        onClick={() => setTheme("dark")}
      >
        Dark
      </button>
    </div>
  );

  if (player.status === "error") {
    return (
      <div className="demo-panel demo-panel-error">
        <span className="demo-panel-badge">DEMO</span>
        <span>{player.error ?? "demo failed"}</span>
        {themeButtons}
      </div>
    );
  }
  if (player.status === "loading" || player.status === "idle") {
    return (
      <div className="demo-panel">
        <span className="demo-panel-badge">DEMO</span>
        <span className="demo-panel-muted">Loading demo session…</span>
        {themeButtons}
      </div>
    );
  }

  const session = player.session;
  const timelineHref = session ? demoUrl(session.timeline_url) : "#";

  return (
    <div className="demo-panel">
      <div className="demo-panel-row demo-panel-status">
        <span className="demo-panel-badge">DEMO</span>
        <span className="demo-panel-id">{session?.session_id ?? "—"}</span>
        <span>
          {fmtClock(player.currentTime)} / {fmtClock(player.duration)}
        </span>
        <span className="demo-panel-muted">
          climax {fmtClock(session?.climax_at ?? 0)}
        </span>
      </div>
      <input
        className="demo-panel-seek"
        type="range"
        min={0}
        max={Math.max(player.duration, 0.1)}
        step={0.1}
        value={Math.min(player.currentTime, player.duration)}
        onChange={(e) => player.seek(Number(e.target.value))}
        aria-label="Seek"
      />
      <div className="demo-panel-row demo-panel-actions">
        <button
          type="button"
          onClick={player.playing ? player.pause : player.play}
        >
          {player.playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={player.jumpToClimax}>
          Jump to climax
        </button>
        <a href={timelineHref} download>
          timeline.json
        </a>
      </div>
      {themeButtons}
    </div>
  );
}
