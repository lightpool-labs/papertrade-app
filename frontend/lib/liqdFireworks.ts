import {
  priceCurveTip,
  priceCurveXSpan,
  priceCurveYAt,
} from "@/lib/priceCurveHit";

export const POS_LIQD_EVENT = "lp-pos-liqd";

const STORAGE_KEY = "lp-liqd-fireworks";
const CHANGE_EVENT = "lp-liqd-fireworks";
const GRAVITY = 1400;

type Ash = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  delay: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
};

type Missile = {
  id: string;
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
  targetY: number;
  t: number;
  age: number;
  flight: number;
  label: string;
};

type TailFade = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  life: number;
  max: number;
};

let parts: Ash[] = [];
let missiles: Missile[] = [];
let tails: TailFade[] = [];
const launched = new Set<string>();
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let last = 0;

export function fireworksOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setFireworksOn(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeFireworks(fn: (on: boolean) => void): () => void {
  const run = () => fn(fireworksOn());
  window.addEventListener(CHANGE_EVENT, run);
  window.addEventListener("storage", run);
  return () => {
    window.removeEventListener(CHANGE_EVENT, run);
    window.removeEventListener("storage", run);
  };
}

function resize() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}

function ensureCanvas() {
  if (canvas) return;
  const el = document.createElement("canvas");
  el.className = "liqd-fireworks";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  canvas = el;
  ctx = el.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
}

const ink = document.createElement("canvas");
const inkCtx = ink.getContext("2d", { willReadFrequently: true });

function headSize(m: Missile, climb: number): number {
  return 13 * (1 + climb * (0.9 + m.t * 1.2));
}

function burst(m: Missile) {
  const size = headSize(m, 1);
  const font = `600 ${Math.round(size)}px ui-sans-serif, system-ui, sans-serif`;
  if (inkCtx) {
    inkCtx.font = font;
    const width = Math.ceil(inkCtx.measureText(m.label).width) + 8;
    const height = Math.ceil(size * 1.35);
    ink.width = width;
    ink.height = height;
    inkCtx.font = font;
    inkCtx.textAlign = "left";
    inkCtx.textBaseline = "middle";
    inkCtx.clearRect(0, 0, width, height);
    inkCtx.fillStyle = "#000";
    inkCtx.fillText(m.label, 4, height / 2);
    const pixels = inkCtx.getImageData(0, 0, width, height).data;
    const life = 1.05;
    const step = size > 28 ? 3 : 2;
    const originX = m.x - width / 2;
    const originY = m.y - height / 2;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (pixels[(y * width + x) * 4 + 3] < 128) continue;
        const along = width > 1 ? x / width : 0;
        parts.push({
          x: originX + x,
          y: originY + y,
          vx: 70 + Math.random() * 140 + along * 50,
          vy: (Math.random() - 0.45) * 46,
          age: 0,
          delay: along * 0.16 + Math.random() * 0.05,
          life,
          max: life,
          r: 255,
          g: 186,
          b: 198,
        });
      }
    }
  }
  tails.push({
    x0: m.ox,
    y0: m.oy,
    x1: m.x,
    y1: m.y,
    life: 0.12,
    max: 0.12,
  });
}

function strokeTail(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  alphaScale: number,
) {
  if (!ctx || alphaScale <= 0) return;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, `rgba(255, 220, 226, ${0.12 * alphaScale})`);
  grad.addColorStop(1, `rgba(255, 196, 206, ${0.65 * alphaScale})`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.25;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function draw(dt: number) {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const flying: Missile[] = [];
  for (const m of missiles) {
    m.age += dt;
    m.vy += GRAVITY * dt;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    const curveY = priceCurveYAt(m.x);
    if (curveY != null && m.y <= curveY) {
      burst(m);
      continue;
    }
    if (m.vy >= 0) {
      burst(m);
      continue;
    }
    strokeTail(m.ox, m.oy, m.x, m.y, 1);
    const span = m.oy - m.targetY;
    const climb = span <= 1 ? 1 : Math.min(1, Math.max(0, (m.oy - m.y) / span));
    const size = headSize(m, climb);
    const red = 246 + (255 - 246) * climb;
    const green = 70 + (186 - 70) * climb;
    const blue = 93 + (198 - 93) * climb;
    const alpha = 1 - climb * 0.35;
    ctx.font = `600 ${Math.round(size)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(${red | 0},${green | 0},${blue | 0},${alpha})`;
    ctx.fillText(m.label, m.x, m.y);
    flying.push(m);
  }
  missiles = flying;

  const fading: TailFade[] = [];
  for (const tail of tails) {
    tail.life -= dt;
    if (tail.life <= 0) continue;
    strokeTail(
      tail.x0,
      tail.y0,
      tail.x1,
      tail.y1,
      (tail.life / tail.max) ** 2,
    );
    fading.push(tail);
  }
  tails = fading;

  const next: Ash[] = [];
  for (const p of parts) {
    p.age += dt;
    p.life -= dt;
    if (p.life <= 0) continue;
    const blown = Math.max(0, p.age - p.delay);
    const wind = Math.min(1, blown / 0.16);
    p.x += p.vx * wind * dt;
    p.y += p.vy * wind * dt;
    p.vx += 36 * wind * dt;
    const u = Math.min(1, blown / 0.72);
    const alpha = 1 - u * u;
    const red = p.r + (154 - p.r) * u;
    const green = p.g + (160 - p.g) * u;
    const blue = p.b + (166 - p.b) * u;
    ctx.fillStyle = `rgba(${red | 0},${green | 0},${blue | 0},${alpha})`;
    ctx.fillRect(p.x, p.y, 2, 2);
    next.push(p);
  }
  parts = next;
}

function frame(now: number) {
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
  last = now;
  draw(dt);
  if (parts.length > 0 || missiles.length > 0 || tails.length > 0) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
    last = 0;
    if (ctx && canvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function moneyLabel(notional: number): string {
  if (!Number.isFinite(notional) || notional <= 0) return "$0";
  if (notional >= 1_000_000) return `$${(notional / 1_000_000).toFixed(1)}M`;
  if (notional >= 1_000) return `$${(notional / 1_000).toFixed(1)}K`;
  return `$${notional.toFixed(0)}`;
}

function priceCurveBox(): { top: number; bottom: number } | null {
  const el = document.querySelector(".mark-curve, .candle-canvas");
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.height < 8) return null;
  return { top: rect.top, bottom: rect.bottom };
}

function momentum(margin: number): number {
  if (!Number.isFinite(margin) || margin <= 0) return 0;
  const t = Math.log10(Math.max(margin, 1)) / 3;
  return Math.min(1, Math.max(0, t));
}

function cssRgb(color: string): [number, number, number] {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return [232, 234, 237];
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function spawnInk(
  originX: number,
  originY: number,
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
  step: number,
  rgb: [number, number, number],
) {
  const life = 1.05;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (pixels[(y * width + x) * 4 + 3] < 128) continue;
      const along = width > 1 ? x / width : 0;
      parts.push({
        x: originX + x,
        y: originY + y,
        vx: 70 + Math.random() * 140 + along * 50,
        vy: (Math.random() - 0.45) * 46,
        age: 0,
        delay: along * 0.16 + Math.random() * 0.05,
        life,
        max: life,
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
      });
    }
  }
}

export function blowPositionRow(row: HTMLElement) {
  if (!inkCtx) return;
  ensureCanvas();
  const cells = row.querySelectorAll("td");
  cells.forEach((cell) => {
    const text = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) return;
    const rect = cell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const style = getComputedStyle(cell);
    const size = Math.max(12, parseFloat(style.fontSize) || 13) * 1.06;
    const font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
    inkCtx.font = font;
    const width = Math.max(8, Math.ceil(inkCtx.measureText(text).width) + 4);
    const height = Math.ceil(size * 1.4);
    ink.width = width;
    ink.height = height;
    inkCtx.font = font;
    inkCtx.textAlign = "left";
    inkCtx.textBaseline = "middle";
    inkCtx.clearRect(0, 0, width, height);
    inkCtx.fillStyle = "#000";
    inkCtx.fillText(text, 2, height / 2);
    spawnInk(
      rect.left,
      rect.top + rect.height / 2 - height / 2,
      width,
      height,
      inkCtx.getImageData(0, 0, width, height).data,
      3,
      cssRgb(style.color),
    );
  });
  if (!raf) raf = requestAnimationFrame(frame);
}

export function launchLiqdAsh(
  x: number,
  y: number,
  notional: number,
  id = "",
) {
  if (!fireworksOn()) return;
  if (id && launched.has(id)) return;
  const span = priceCurveXSpan();
  if (!span || x < span.x0 || x > span.x1) return;
  ensureCanvas();
  const t = momentum(notional);
  const startX = x;
  const startY = y;
  const tip = priceCurveTip();
  const curve = priceCurveBox();
  const room = Math.max(48, startY - 72);
  const targetY = tip ? tip.y : curve ? curve.top : startY - room * 0.9;
  const rise = Math.max(24, startY - targetY);
  const vy = -Math.sqrt(2 * GRAVITY * rise);
  const flightT = -vy / GRAVITY;
  const vx = tip
    ? (tip.x - startX) / flightT
    : (40 + t * 320) * (0.85 + Math.random() * 0.3);
  const missileId = id || `${startX.toFixed(0)}:${startY.toFixed(0)}:${Date.now()}`;
  if (id) launched.add(id);
  missiles.push({
    id: missileId,
    x: startX,
    y: startY,
    vx,
    vy,
    ox: startX,
    oy: startY,
    targetY,
    t,
    age: 0,
    flight: 0.14 + t * 0.1,
    label: moneyLabel(notional),
  });
  if (!raf) raf = requestAnimationFrame(frame);
}
