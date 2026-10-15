"use client";

import { useEffect, useRef } from "react";
import {
  subscribePaperPositions,
  type PaperPositionEvent,
} from "@/lib/paperPositionsWs";
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

/** Size = margin × leverage = notional (human USDC). */
function sizeLabel(ev: PaperPositionEvent): string {
  const nr = Number(ev.notional_raw);
  const n =
    Number.isFinite(nr) && nr > 0 ? nr / TOKEN_SCALE : parseAmount(ev.notional ?? "");
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
  el.dataset.size = sizeLabel(ev);
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

  notion.textContent = sizeLabel(ev);
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
    let seq = 0;
    /** Original chip under the freeze clone (may scroll away; banner never pauses). */
    let hoverChip: HTMLElement | null = null;
    let freezeClone: HTMLElement | null = null;

    const stickEnd = () => {
      scroller.scrollLeft = scroller.scrollWidth;
    };

    /** Drop a chip; if it was leading, compensate scroll so content never jumps L→R. */
    const removeChip = (el: HTMLElement) => {
      const wasFirst = el === track.firstElementChild;
      const w = el.getBoundingClientRect().width + TRACK_GAP;
      if (el === hoverChip) hoverChip = null;
      el.remove();
      if (!wasFirst) return;
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft - w);
    };

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

      const rows: Array<[string, string]> = [["Size", size]];
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

    const onScroll = () => {
      scroller.scrollLeft = scroller.scrollWidth;
    };
    scroller.addEventListener("scroll", onScroll);

    const unsub = subscribePaperPositions({
      onEvent: (ev: PaperPositionEvent) => {
        const kind = normalizeKind(ev.event);
        if (!kind) return;
        const m = (ev.market ?? "").trim().toLowerCase();
        if (marketKey && m && m !== marketKey) return;

        seq += 1;
        const chip = makeChip(ev, kind, `${seq}-${ev.position ?? 0}-${kind}`);
        bindChipHover(chip);
        track.appendChild(chip);
        idle.hidden = true;

        while (track.childElementCount > MAX_ITEMS) {
          const first = track.firstElementChild as HTMLElement | null;
          if (!first) break;
          removeChip(first);
        }
        requestAnimationFrame(stickEnd);
      },
    });

    return () => {
      unsub();
      scroller.removeEventListener("scroll", onScroll);
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
