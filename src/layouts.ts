/**
 * Hall templates: where every seat sits on the site's seat map, so the
 * dashboard can draw the same columns, aisles and gaps. Pure; unit-tested.
 */
import { readFileSync } from 'node:fs';
import type { DetectedGeometry } from './sources/seat-geometry.js';
import type { SeatRow } from './sources/types.js';

export interface HallTemplate {
  venue: string;
  screen: string;
  /** Number of grid columns / lines (gaps included) */
  cols: number;
  lines: number;
  /** Rows top → bottom as drawn (screen at the bottom) */
  rows: { row: string; line: number; seats: { n: string; col: number }[] }[];
  capturedAt: string;
}

export type LayoutFile = Record<string, HallTemplate>;

export const layoutId = (venue: string, screen: string) => `${venue.toUpperCase()}:${screen.trim().toUpperCase()}`;

/**
 * Merge two detections of the same hall taken at different pan positions.
 * Seats form a regular grid, so many shifts line boxes up; the right one is
 * found by matching the irregular free/sold pattern (score = matches − 2 ×
 * mismatches), with the expected pan distance only breaking ties.
 * Boxes are then unioned (duplicates within half a seat are dropped).
 */
export function mergeGeometry(a: DetectedGeometry, b: DetectedGeometry, expectedDx: number): DetectedGeometry {
  if (a.error || b.error || a.lines.length !== b.lines.length) {
    throw new Error(`cannot merge pan passes (${a.lines.length} vs ${b.lines.length} lines)`);
  }
  const half = a.size / 2;
  const candidates = new Set<number>();
  a.lines.forEach((la, i) => {
    for (const xa of la.xs) for (const xb of b.lines[i]!.xs) candidates.add(Math.round(xa - xb));
  });

  let best = { dx: Number.NaN, score: -Infinity, dist: Infinity };
  for (const dx of candidates) {
    let score = 0;
    a.lines.forEach((la, i) => {
      const lb = b.lines[i]!;
      lb.xs.forEach((xb, j) => {
        const k = la.xs.findIndex((xa) => Math.abs(xa - (xb + dx)) < half);
        if (k < 0) return;
        const same = !la.kinds || !lb.kinds || la.kinds[k] === lb.kinds[j];
        score += same ? 1 : -2;
      });
    });
    const dist = Math.abs(dx - expectedDx);
    if (score > best.score || (score === best.score && dist < best.dist)) best = { dx, score, dist };
  }
  if (!(best.score > 0)) throw new Error('no overlap between pan passes');

  return {
    size: a.size,
    clipped: false,
    lines: a.lines.map((la, i) => {
      const lb = b.lines[i]!;
      const items = la.xs.map((x, j) => ({ x, k: la.kinds?.[j] ?? 'f' }));
      lb.xs.forEach((xb, j) => {
        const x = xb + best.dx;
        if (!items.some((it) => Math.abs(it.x - x) < half)) items.push({ x, k: lb.kinds?.[j] ?? 'f' });
      });
      items.sort((p, q) => p.x - q.x);
      return { y: la.y, xs: items.map((it) => it.x), kinds: items.map((it) => it.k).join('') };
    }),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * @param rowsTopToBottom hall rows in drawn order (back at the top), e.g. ["A", … "N"]
 * @param listed seat lists from the accessibility dialog (rows with free seats), in drawn order
 * @param leftToRight numbering direction, used for rows the dialog doesn't list (fully booked)
 */
export function buildTemplate(
  venue: string,
  screen: string,
  geo: DetectedGeometry,
  rowsTopToBottom: string[],
  listed: SeatRow[],
  leftToRight: 'asc' | 'desc',
): HallTemplate {
  if (geo.error) throw new Error(geo.error);
  if (geo.lines.length !== rowsTopToBottom.length) {
    throw new Error(`found ${geo.lines.length} seat lines but the hall has ${rowsTopToBottom.length} rows`);
  }

  // Grid steps: the typical distance between neighbouring seats / lines.
  const dx = median(geo.lines.flatMap((l) => l.xs.slice(1).map((x, i) => x - l.xs[i]!)).filter((d) => d > geo.size * 0.8));
  const dy = median(geo.lines.slice(1).map((l, i) => l.y - geo.lines[i]!.y));
  const minX = Math.min(...geo.lines.flatMap((l) => l.xs));
  const minY = geo.lines[0]!.y;

  const byRow = new Map(listed.map((r) => [r.row, r]));
  const padded = listed.some((r) => r.seats.some((s) => /^0\d/.test(s.n)));

  const rows = geo.lines.map((l, i) => {
    const row = rowsTopToBottom[i]!;
    const k = l.xs.length;
    const fromSite = byRow.get(row)?.seats.map((s) => s.n);
    let numbers: string[];
    if (fromSite && fromSite.length === k) {
      numbers = fromSite;
    } else {
      if (fromSite) throw new Error(`row ${row}: ${k} boxes on the map but ${fromSite.length} seats in the list`);
      numbers = Array.from({ length: k }, (_, j) => String(leftToRight === 'asc' ? j + 1 : k - j));
      if (padded) numbers = numbers.map((n) => n.padStart(2, '0'));
    }
    return {
      row,
      line: Math.round((l.y - minY) / dy),
      seats: l.xs.map((x, j) => ({ n: numbers[j]!, col: Math.round((x - minX) / dx) })),
    };
  });

  return {
    venue,
    screen,
    cols: Math.max(...rows.flatMap((r) => r.seats.map((s) => s.col))) + 1,
    lines: rows[rows.length - 1]!.line + 1,
    rows,
    capturedAt: new Date().toISOString(),
  };
}

export function readLayouts(path: string): LayoutFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LayoutFile;
  } catch {
    return {};
  }
}
