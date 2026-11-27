/**
 * Runs INSIDE the page (passed to page.evaluate), so it must be fully
 * self-contained: no imports, no outside helpers.
 *
 * Finds seat boxes on the seat map canvas: every near-square blob of the
 * dominant seat size, grouped into visual lines (top → bottom) and sorted
 * left → right. Coordinates are canvas pixels.
 */
export interface DetectedGeometry {
  error?: string;
  size: number;
  /** True when a seat touches the canvas edge (hall wider/taller than the drawing area) */
  clipped?: boolean;
  /** kinds[i] per box: "f" = free (white inside), "s" = sold/booked (filled) */
  lines: { y: number; xs: number[]; kinds?: string }[];
}

export function detectSeatBoxes(): DetectedGeometry {
  const canvases = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height);
  const cv = canvases[0];
  if (!cv) return { error: 'no canvas', size: 0, lines: [] };
  const W = cv.width;
  const H = cv.height;
  let data: Uint8ClampedArray;
  try {
    data = cv.getContext('2d')!.getImageData(0, 0, W, H).data;
  } catch (e) {
    return { error: `canvas not readable: ${(e as Error).message}`, size: 0, lines: [] };
  }

  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3]! < 40) continue;
    if (data[p]! > 242 && data[p + 1]! > 242 && data[p + 2]! > 242) continue; // background
    mask[i] = 1;
  }

  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comps: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (sp) {
      const k = stack[--sp]!;
      const x = k % W;
      const y = (k / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (x < W - 1 && mask[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (y > 0 && mask[k - W] && !seen[k - W]) { seen[k - W] = 1; stack[sp++] = k - W; }
      if (y < H - 1 && mask[k + W] && !seen[k + W]) { seen[k + W] = 1; stack[sp++] = k + W; }
    }
    comps.push({ x0, y0, x1, y1 });
  }

  const squares = comps
    .map((c) => ({ ...c, w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 }))
    .filter((c) => c.w >= 8 && c.h >= 8 && Math.abs(c.w - c.h) <= Math.max(2, c.w * 0.15));
  const hist = new Map<number, number>();
  for (const c of squares) {
    const k = Math.round(c.w / 2) * 2;
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const size = [...hist].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (!size) return { error: 'no seat boxes found', size: 0, lines: [] };

  const boxes = squares
    .filter((c) => Math.abs(c.w - size) <= size * 0.2 && Math.abs(c.h - size) <= size * 0.2)
    .map((c) => {
      // Sample inside the box, left of the number: white = free, filled = sold.
      const px = c.x0 + Math.max(3, Math.round(c.w * 0.18));
      const py = c.y0 + Math.round(c.h / 2);
      const o = (py * W + px) * 4;
      const free = data[o]! > 242 && data[o + 1]! > 242 && data[o + 2]! > 242;
      return { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2, k: free ? 'f' : 's' };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const raw: { y: number; items: { x: number; k: string }[] }[] = [];
  for (const b of boxes) {
    const last = raw[raw.length - 1];
    if (last && Math.abs(last.y - b.y) < size * 0.5) last.items.push(b);
    else raw.push({ y: b.y, items: [b] });
  }
  const lines = raw.map((l) => {
    const items = l.items.sort((a, b) => a.x - b.x);
    return { y: l.y, xs: items.map((i) => i.x), kinds: items.map((i) => i.k).join('') };
  });
  const edge = size * 1.6; // a partly-cut seat at the edge is filtered out, so allow one more seat of margin
  const clipped =
    lines.some((l) => l.xs[0]! < edge || l.xs[l.xs.length - 1]! > W - edge) ||
    lines[0]!.y < edge ||
    lines[lines.length - 1]!.y > H - edge;
  return { size, lines, clipped };
}
