type Pt = { x: number; y: number };

let line: Pt[] = [];

export function publishPriceCurve(points: Pt[]) {
  line = points;
}

export function clearPriceCurve() {
  line = [];
}

export function priceCurveXSpan(): { x0: number; x1: number } | null {
  if (line.length < 2) return null;
  return { x0: line[0].x, x1: line[line.length - 1].x };
}

export function priceCurveTip(): { x: number; y: number } | null {
  if (line.length === 0) return null;
  return line[line.length - 1];
}

export function priceCurveYAt(x: number): number | null {
  if (line.length === 0) return null;
  if (x < line[0].x || x > line[line.length - 1].x) return null;
  let i = 1;
  while (i < line.length && line[i].x < x) i++;
  const a = line[i - 1];
  const b = line[Math.min(i, line.length - 1)];
  if (b.x === a.x) return a.y;
  const u = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * u;
}
