"use client";

import { useEffect, useRef } from "react";
import {
  subscribePaperPositions,
  type PaperPositionEvent,
} from "@/lib/paperPositionsWs";
import { launchLiqdAsh, fireworksOn } from "@/lib/liqdFireworks";
import { priceCurveXSpan } from "@/lib/priceCurveHit";
import { parseAmount } from "@/lib/math";

const MAX_ITEMS = 80;
const TOKEN_SCALE = 1_000_000;

type Kind = "opened" | "closed" | "liquidated";

type Props = {
  market?: string;
};

function normalizeKind(event: string | undefined): Kind | null {
  const e = (event ?? "").toLowerCase();
  if (e === "opened" || e === "open") return "opened";
  if (e === "closed" || e === "close") return "closed";
  if (e === "liquidated" || e === "liqd" || e === "liquidation") {
    return "liquidated";
  }
  return null;
}

function kindClass(kind: Kind): string {
  if (kind === "opened") return "house-activity-open";
  if (kind === "closed") return "house-activity-close";
  return "house-activity-liqd";
}

function assetName(ev: PaperPositionEvent): string {
  const n = ev.instrument_name?.trim();
  if (n) return n.toUpperCase();
  if (ev.instrument === 0) return "BTC";
  if (ev.instrument != null) return `#${ev.instrument}`;
  return "BTC";
}

function shortWallet(raw: string): string {
  const s = raw.trim();
  if (s.length <= 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function moneyCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(1)}`;
}

function amountHuman(raw: number | undefined, text: string | undefined): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n / TOKEN_SCALE;
  const parsed = parseAmount(text ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function chipAmount(ev: PaperPositionEvent, kind: Kind): number {
  const margin = amountHuman(ev.margin_raw, ev.margin);
  if (margin > 0) return margin;
  if (kind === "liquidated") {
    if (ev.pnl_raw != null && Number.isFinite(Number(ev.pnl_raw))) {
      return Math.abs(Number(ev.pnl_raw)) / TOKEN_SCALE;
    }
    const pnl = parseAmount(ev.pnl ?? "");
    if (Number.isFinite(pnl)) return Math.abs(pnl);
  }
  return 0;
}

/** Banner amount is margin (user funds), not notional. */
function sizeLabel(ev: PaperPositionEvent, kind: Kind): string {
  const n = chipAmount(ev, kind);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `$${moneyCompact(n)}`;
}

function pnlLabel(ev: PaperPositionEvent, kind: Kind): string {
  if (kind === "opened") return "";
  let human = NaN;
  // Avoid Number(null) === 0 treating missing pnl_raw as zero.
  if (ev.pnl_raw != null && ev.pnl_raw !== ("" as unknown as number)) {
    const pr = Number(ev.pnl_raw);
    if (Number.isFinite(pr)) human = pr / TOKEN_SCALE;
  }
  if (!Number.isFinite(human)) {
    human = parseAmount(ev.pnl ?? "");
  }
  if (!Number.isFinite(human)) return "—";
  const sign = human > 0 ? "+" : human < 0 ? "-" : "";
  return `${sign}$${moneyCompact(Math.abs(human))}`;
}

function tipTitle(ev: PaperPositionEvent, kind: Kind): string {
  const asset = assetName(ev);
  if (kind === "opened") {
    if (ev.is_long === true) return `${asset} long`;
    if (ev.is_long === false) return `${asset} short`;
    return `${asset} open`;
  }
  if (kind === "closed") return `${asset} close`;
  return `${asset} liqd`;
}

function tipTitleTone(
  ev: PaperPositionEvent,
  kind: Kind,
): "long" | "short" | "close" | "liqd" | "flat" {
  if (kind === "opened") {
    if (ev.is_long === true) return "long";
    if (ev.is_long === false) return "short";
    return "flat";
  }
  if (kind === "closed") return "close";
  return "liqd";
}

function sideTone(ev: PaperPositionEvent): "up" | "down" | "flat" {
  if (ev.is_long === true) return "up";
  if (ev.is_long === false) return "down";
  return "flat";
}

function btcLogoEl(): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "house-activity-logo house-activity-logo-btc";
  wrap.setAttribute("aria-label", "BTC");
  wrap.title = "BTC";
  wrap.textContent = "₿";
  return wrap;
}

function assetEl(ev: PaperPositionEvent): HTMLElement {
  const name = assetName(ev);
  if (name === "BTC" || name.includes("BTC") || ev.instrument === 0) {
    return btcLogoEl();
  }
  const asset = document.createElement("strong");
  asset.className = "house-activity-asset";
  asset.textContent = name;
  return asset;
}

function makeChip(ev: PaperPositionEvent, kind: Kind, id: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `house-activity-item ${kindClass(kind)}`;
  el.dataset.id = id;
  el.dataset.kind = kind;
  el.dataset.title = tipTitle(ev, kind);
  el.dataset.titleTone = tipTitleTone(ev, kind);
  el.dataset.size = sizeLabel(ev, kind);
  el.dataset.pnl = pnlLabel(ev, kind);
  el.dataset.wallet = ev.user_address?.trim() || "—";

  el.appendChild(assetEl(ev));

  const notion = document.createElement("span");
  notion.className = "house-activity-size";

  if (kind === "opened") {
    const tone = sideTone(ev);
    const tri = document.createElement("span");
    tri.className = `house-activity-tri house-activity-tri-${tone}`;
    el.appendChild(tri);
    notion.classList.add(`house-activity-tone-${tone}`);
  } else if (kind === "liquidated") {
    const liq = document.createElement("span");
    liq.className = "house-activity-liq-tag";
    liq.textContent = "liq";
    el.appendChild(liq);
  }

  notion.textContent = sizeLabel(ev, kind);
  el.appendChild(notion);
  return el;
}

/**
 * Hover: pin a clone + tip; the banner stream keeps running underneath.
 */
export function HouseActivityBanner({ market }: Props) {
  const marketKey = market?.trim().toLowerCase() ?? "";
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();

    const idle = document.createElement("div");
    idle.className = "house-activity-idle-wrap";
    const idleText = document.createElement("span");
    idleText.className = "house-activity-idle";
    idleText.textContent = "Waiting for opens / closes / liquidations…";
    idle.appendChild(idleText);

    const scroller = document.createElement("div");
    scroller.className = "house-activity-scroller";

    const track = document.createElement("div");
    track.className = "house-activity-track";
    scroller.appendChild(track);

    const tip = document.createElement("div");
    tip.className = "house-activity-tip";
    tip.hidden = true;
    document.body.appendChild(tip);

    host.appendChild(idle);
    host.appendChild(scroller);

    const TRACK_GAP = 28;
    const MIN_SPEED = 140;
    type Boat = { el: HTMLElement; x: number; w: number };
    const boats: Boat[] = [];
    const waiting: HTMLElement[] = [];
    const eventTimes: number[] = [];
    let seq = 0;
    /** Original chip under the freeze clone (may scroll away; banner never pauses). */
    let hoverChip: HTMLElement | null = null;
    let freezeClone: HTMLElement | null = null;
    let raf = 0;
    let lastTick = 0;
    let speed = MIN_SPEED;

    const placeBoat = (boat: Boat) => {
      boat.el.style.transform = `translate3d(${boat.x}px, -50%, 0)`;
    };

    const viewWidth = () => {
      const width = Math.max(
        host.getBoundingClientRect().width,
        track.getBoundingClientRect().width,
        window.innerWidth,
      );
      return width > 0 ? width : window.innerWidth;
    };

    const eventsPerSecond = () => {
      const cutoff = performance.now() - 1000;
      while (eventTimes.length > 0 && eventTimes[0] < cutoff) eventTimes.shift();
      return eventTimes.length;
    };

    const boatGap = () => {
      const rate = eventsPerSecond();
      if (rate <= 1) return TRACK_GAP;
      const t = Math.min(1, (rate - 1) / 7);
      return TRACK_GAP + (2 - TRACK_GAP) * t;
    };

    const releaseWaiting = () => {
      const viewW = viewWidth();
      const gap = boatGap();
      const place = (el: HTMLElement, x: number, w: number) => {
        const boat: Boat = { el, x, w };
        placeBoat(boat);
        boats.push(boat);
      };
      const measure = () => {
        const el = waiting.shift();
        if (!el) return null;
        track.appendChild(el);
        return { el, w: Math.max(el.offsetWidth, 148) };
      };

      while (waiting.length > 0) {
        const last = boats[boats.length - 1];
        const behind = last ? last.x + last.w + gap : null;
        if (behind != null && behind > viewW) break;

        if (behind == null || behind < 0) {
          const batch: Array<{ el: HTMLElement; w: number }> = [];
          let used = 0;
          while (waiting.length > 0) {
            const item = measure();
            if (!item) break;
            const need = item.w + (batch.length > 0 ? gap : 0);
            if (batch.length > 0 && used + need > viewW) {
              item.el.remove();
              waiting.unshift(item.el);
              break;
            }
            batch.push(item);
            used += need;
          }
          let x = Math.max(0, viewW - used);
          for (const item of batch) {
            place(item.el, x, item.w);
            x += item.w + gap;
          }
          break;
        }

        const item = measure();
        if (!item) break;
        place(item.el, behind, item.w);
      }
    };

    const enqueueBoat = (el: HTMLElement) => {
      eventTimes.push(performance.now());
      waiting.push(el);
      while (waiting.length > MAX_ITEMS) {
        const dropped = waiting.shift();
        if (!dropped) break;
        if (dropped === hoverChip) hoverChip = null;
        dropped.remove();
      }
      idle.hidden = true;
      releaseWaiting();
    };

    const tick = (now: number) => {
      raf = window.requestAnimationFrame(tick);
      if (!lastTick) lastTick = now;
      const dt = Math.min(0.05, (now - lastTick) / 1000);
      lastTick = now;
      const gap = boatGap();
      const spacing = (boats[boats.length - 1]?.w ?? 148) + gap;
      const target = Math.max(MIN_SPEED, eventsPerSecond() * spacing);
      speed = target;
      const dx = speed * dt;
      for (const boat of boats) {
        boat.x -= dx;
        placeBoat(boat);
      }
      if (fireworksOn()) {
        const span = priceCurveXSpan();
        const hostBox = host.getBoundingClientRect();
        const fireY = hostBox.top + hostBox.height / 2;
        for (const boat of boats) {
          const chip = boat.el;
          if (chip.dataset.kind !== "liquidated" || chip.dataset.liqdFired) continue;
          const cx = hostBox.left + boat.x + boat.w / 2;
          const prevCx = cx + dx;
          const loss = Number(chip.dataset.liqdLoss) || 0;
          let fireX = cx;
          if (span) {
            const fromLeft = Math.min(1, Math.max(0, 1 - Math.log10(Math.max(loss, 1)) / 3.75));
            const targetX = span.x0 + fromLeft * (span.x1 - span.x0);
            const crossed = prevCx >= targetX && cx <= targetX;
            if (!crossed && cx > targetX) continue;
            fireX = targetX;
          } else if (cx > window.innerWidth && prevCx > window.innerWidth) {
            continue;
          } else if (prevCx > window.innerWidth && cx < 0) {
            fireX = window.innerWidth * 0.5;
          } else if (cx > window.innerWidth) {
            continue;
          }
          chip.dataset.liqdFired = "1";
          launchLiqdAsh(fireX, fireY, loss, chip.dataset.id ?? "");
        }
      }
      while (boats.length > 0 && boats[0].x + boats[0].w < 0) {
        const gone = boats.shift();
        if (!gone) break;
        if (gone.el === hoverChip) hoverChip = null;
        gone.el.remove();
      }
      releaseWaiting();
      if (boats.length === 0 && waiting.length === 0) idle.hidden = false;
    };
    raf = window.requestAnimationFrame(tick);

    const placeTip = (anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      tip.hidden = false;
      const tipW = Math.max(tip.offsetWidth, 220);
      const tipH = Math.max(tip.offsetHeight, 110);
      let left = rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
      let top = rect.top - tipH - 10;
      if (top < 8) top = rect.bottom + 10;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const clearFreeze = () => {
      freezeClone?.remove();
      freezeClone = null;
      if (hoverChip) {
        hoverChip.classList.remove("house-activity-ghost");
        hoverChip.classList.remove("house-activity-hovered");
      }
    };

    const hideTip = () => {
      tip.hidden = true;
      tip.replaceChildren();
      clearFreeze();
      hoverChip = null;
    };

    const fillTip = (chip: HTMLElement) => {
      const title = chip.dataset.title || "—";
      const size = chip.dataset.size || "—";
      const pnl = chip.dataset.pnl || "";
      const wallet = shortWallet(chip.dataset.wallet || "");
      const kind = chip.dataset.kind || "";
      tip.replaceChildren();

      const head = document.createElement("div");
      const tone = chip.dataset.titleTone || "flat";
      head.className = `house-activity-tip-title house-activity-tip-title-${tone}`;
      head.textContent = title;
      tip.appendChild(head);

      const rows: Array<[string, string]> = [["Margin", size]];
      // Opens have no realized PnL; close / liqd always show the row.
      if (kind === "closed" || kind === "liquidated") {
        rows.push(["PnL", pnl || "—"]);
      }
      rows.push(["Wallet", wallet]);
      for (const [k, v] of rows) {
        const row = document.createElement("div");
        row.className = "house-activity-tip-row";
        const key = document.createElement("span");
        key.textContent = k;
        const val = document.createElement("strong");
        val.textContent = v;
        row.appendChild(key);
        row.appendChild(val);
        tip.appendChild(row);
      }
    };

    const isStillOnHover = (related: Node | null) => {
      if (!related) return false;
      if (hoverChip === related || hoverChip?.contains(related)) return true;
      if (freezeClone === related || freezeClone?.contains(related)) return true;
      if (tip === related || tip.contains(related)) return true;
      return false;
    };

    const onFreezeLeave = (e: Event) => {
      if (isStillOnHover((e as MouseEvent).relatedTarget as Node | null)) return;
      hideTip();
    };

    const showTip = (chip: HTMLElement) => {
      if (freezeClone && hoverChip === chip) {
        placeTip(freezeClone);
        return;
      }

      clearFreeze();
      hoverChip = chip;

      const rect = chip.getBoundingClientRect();
      const clone = chip.cloneNode(true) as HTMLElement;
      clone.classList.add("house-activity-frozen");
      clone.classList.add("house-activity-hovered");
      clone.style.transform = "";
      clone.style.top = `${rect.top}px`;
      clone.addEventListener("mouseleave", onFreezeLeave);
      document.body.appendChild(clone);
      const cw = clone.offsetWidth || rect.width;
      clone.style.left = `${rect.left + rect.width / 2 - cw / 2}px`;
      freezeClone = clone;

      // Ghost only — stream keeps running at full speed underneath.
      chip.classList.add("house-activity-ghost");
      fillTip(chip);
      placeTip(clone);
    };

    const onChipEnter = (e: Event) => {
      showTip(e.currentTarget as HTMLElement);
    };
    const onChipLeave = (e: Event) => {
      const chip = e.currentTarget as HTMLElement;
      if (isStillOnHover((e as MouseEvent).relatedTarget as Node | null)) return;
      if (hoverChip === chip) hideTip();
    };

    const bindChipHover = (chip: HTMLElement) => {
      chip.addEventListener("mouseenter", onChipEnter);
      chip.addEventListener("mouseleave", onChipLeave);
    };

    const unsub = subscribePaperPositions({
      onEvent: (ev: PaperPositionEvent) => {
        const kind = normalizeKind(ev.event);
        if (!kind) return;
        const m = (ev.market ?? "").trim().toLowerCase();
        if (marketKey && m && m !== marketKey) return;

        seq += 1;
        const chip = makeChip(ev, kind, `${seq}-${ev.position ?? 0}-${kind}`);
        if (seq % 20 === 0) {
          const colors = ["#e11d48", "#f59e0b", "#2563eb", "#16a34a", "#7c3aed", "#111827"];
          const n = seq / 20;
          const flag = document.createElement("span");
          flag.className = "house-activity-flag";
          flag.textContent = String(seq);
          flag.style.background = colors[(n - 1) % colors.length];
          chip.prepend(flag);
        }
        if (kind === "liquidated") {
          chip.dataset.liqdLoss = String(chipAmount(ev, kind));
        }
        bindChipHover(chip);
        idle.hidden = true;
        enqueueBoat(chip);
      },
    });

    return () => {
      unsub();
      window.cancelAnimationFrame(raf);
      hideTip();
      tip.remove();
      host.replaceChildren();
    };
  }, [marketKey]);

  return (
    <div
      ref={hostRef}
      className="house-activity-banner"
      aria-live="polite"
    />
  );
}
