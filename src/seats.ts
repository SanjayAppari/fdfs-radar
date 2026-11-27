/**
 * "Is there a good (middle) seat?" — pure logic, unit-tested.
 *
 * Geometry: `hallRows` are ordered front (nearest the screen) → back. Halls
 * differ: in some row A is at the screen, in others at the back, so the order
 * comes from config ("A-N" vs "N-A") or, when learned, assumes A = front.
 * A row is "middle" when its depth fraction is within [rowsFrom, rowsTo]
 * (0 = front row, 1 = back row). A seat is "middle" when it sits within the
 * central `centerWidth` share of its row.
 */
import type { SeatMap } from './sources/types.js';

export interface MiddlePolicy {
  /** 0 = front row, 1 = back row */
  rowsFrom: number;
  rowsTo: number;
  /** Central share of each row that counts as middle, 0–1 */
  centerWidth: number;
  /** Need this many adjacent middle seats for the show to count as "good" */
  seatsTogether: number;
}

export interface ScreenOverride {
  /**
   * Rows from the screen to the back: "A-N" (A at the screen) or "N-A"
   * (N at the screen). Lists work too: "A-H,J-N".
   */
  rows?: string;
  /** Explicit list of rows you consider good; skips the depth calculation */
  goodRows?: string[];
  /** Seat numbers as seen facing the screen: "asc" = 1 on the left, "desc" = highest on the left */
  leftToRight?: 'asc' | 'desc';
}

export interface SeatView {
  n: string;
  free: boolean;
  middle: boolean;
}

export interface RowSummary {
  row: string;
  category: string;
  price: string;
  free: number;
  total: number;
  middleFree: number;
  goodRow: boolean;
  seats: SeatView[];
}

export interface SeatSummary {
  checkedAt: string;
  totalFree: number;
  middleFree: number;
  /** Longest run of adjacent free middle seats */
  bestBlock: number;
  /** True when bestBlock >= seatsTogether */
  middleOk: boolean;
  /** All rows of the hall, front (screen) → back */
  hallRows: string[];
  /**
   * config   = rows from config.json (direction confirmed or not contradicted)
   * detected = direction read from the site's own row order
   * unknown  = direction could not be determined; middle seats are not claimed
   */
  layoutSource: LayoutSource;
  goodRows: string[];
  /** Rows with at least one free seat (front → back) */
  rows: RowSummary[];
}

export type LayoutSource = 'config' | 'detected' | 'unknown';

/**
 * Direction of the hall from the site's row lists. Within one seat class the
 * site lists rows top → bottom as drawn, and the screen is always drawn at the
 * bottom. 'asc' = letters increase towards the screen (A at the back);
 * 'desc' = letters decrease towards the screen (A at the screen).
 */
export type RowOrder = 'asc' | 'desc';

export function detectRowOrder(rows: { row: string; category: string }[]): RowOrder | null {
  let up = 0;
  let down = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.category !== b.category) continue;
    const c = rowCompare(a.row, b.row);
    if (c < 0) up++;
    else if (c > 0) down++;
  }
  if (up && !down) return 'asc';
  if (down && !up) return 'desc';
  if (up >= 3 * down && up >= 3) return 'asc';
  if (down >= 3 * up && down >= 3) return 'desc';
  return null;
}

/** Direction implied by a config spec written screen → back ("N-A" ⇒ 'asc'). */
export function orderOfSpec(spec: string): RowOrder | null {
  const rows = expandRows(spec);
  if (rows.length < 2) return null;
  return rowCompare(rows[0]!, rows[rows.length - 1]!) > 0 ? 'asc' : 'desc';
}

/** Hall rows screen → back for a set of row letters and a direction. */
export function hallFor(letters: Iterable<string>, order: RowOrder): string[] {
  const sorted = sortRows(letters);
  return order === 'desc' ? sorted : sorted.reverse();
}

export const rowCompare = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

export const sortRows = (rows: Iterable<string>) => [...new Set(rows)].sort(rowCompare);

/**
 * "A-N" → [A..N], "N-A" → [N..A], "A-H,J-N" → [A..H, J..N].
 * Order is preserved: it means front (screen) → back.
 */
export function expandRows(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean)) {
    const m = /^([A-Z])\s*-\s*([A-Z])$/.exec(part);
    if (m) {
      const [a, b] = [m[1]!.charCodeAt(0), m[2]!.charCodeAt(0)];
      const step = a <= b ? 1 : -1;
      for (let c = a; c !== b + step; c += step) out.push(String.fromCharCode(c));
    } else {
      out.push(part);
    }
  }
  return [...new Set(out)];
}

/** Learned halls: assume rows start at A (front) and run to the furthest row seen. */
export function learnedHall(seen: Iterable<string>): string[] {
  const rows = sortRows(seen);
  const singles = rows.filter((r) => /^[A-Z]$/.test(r));
  if (!singles.length) return rows;
  const max = singles[singles.length - 1]!;
  return [...new Set([...expandRows(`A-${max}`), ...rows])];
}

export function pickGoodRows(hallRows: string[], policy: MiddlePolicy): string[] {
  if (hallRows.length <= 2) return [...hallRows];
  const last = hallRows.length - 1;
  return hallRows.filter((_, i) => {
    const f = i / last;
    return f >= policy.rowsFrom - 1e-9 && f <= policy.rowsTo + 1e-9;
  });
}

const seatNum = (n: string) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) ? v : Number.NaN;
};

export function analyseSeats(
  map: Pick<SeatMap, 'checkedAt' | 'rows'>,
  opts: { hallRows: string[]; layoutSource: LayoutSource; policy: MiddlePolicy; goodRowsOverride?: string[] },
): SeatSummary {
  const { policy } = opts;
  // Keep the configured front→back order; unknown rows (shouldn't happen) go to the back.
  const extra = sortRows(map.rows.map((r) => r.row).filter((r) => !opts.hallRows.includes(r)));
  const hallRows = [...opts.hallRows, ...extra];
  const depth = new Map(hallRows.map((r, i) => [r, i]));
  const override = new Set((opts.goodRowsOverride ?? []).map((r) => r.toUpperCase()));
  const goodRows =
    opts.layoutSource === 'unknown'
      ? []
      : override.size
        ? hallRows.filter((r) => override.has(r))
        : pickGoodRows(hallRows, policy);
  const good = new Set(goodRows);

  let totalFree = 0;
  let middleFree = 0;
  let bestBlock = 0;

  const rows: RowSummary[] = map.rows
    .slice()
    .sort((a, b) => (depth.get(a.row) ?? 0) - (depth.get(b.row) ?? 0))
    .map((r) => {
      const goodRow = good.has(r.row);
      const ordered = r.seats
        .map((s, i) => ({ ...s, i, num: seatNum(s.n) }))
        .sort((a, b) => (Number.isNaN(a.num) || Number.isNaN(b.num) ? a.i - b.i : a.num - b.num));
      const last = ordered.length - 1;
      const half = policy.centerWidth / 2;

      // Middle-ness and adjacency are computed in seat-number order…
      const byNumber: (SeatView & { i: number })[] = ordered.map((s, idx) => {
        const pos = last <= 0 ? 0.5 : idx / last;
        return { n: s.n, free: s.free, middle: goodRow && Math.abs(pos - 0.5) <= half + 1e-9, i: s.i };
      });

      let run = 0;
      byNumber.forEach((s, idx) => {
        const prev = ordered[idx - 1];
        const adjacent = idx > 0 && !Number.isNaN(ordered[idx]!.num) && prev !== undefined && ordered[idx]!.num - prev.num === 1;
        if (s.free && s.middle) {
          run = adjacent && byNumber[idx - 1]!.free && byNumber[idx - 1]!.middle ? run + 1 : 1;
          bestBlock = Math.max(bestBlock, run);
        } else {
          run = 0;
        }
      });

      // …but returned in the site's order, which is left → right as seen
      // facing the screen (halls number seats in different directions).
      const seats: SeatView[] = byNumber.sort((a, b) => a.i - b.i).map(({ n, free, middle }) => ({ n, free, middle }));

      const free = seats.filter((s) => s.free).length;
      const mid = seats.filter((s) => s.free && s.middle).length;
      totalFree += free;
      middleFree += mid;
      return { row: r.row, category: r.category, price: r.price, free, total: seats.length, middleFree: mid, goodRow, seats };
    });

  return {
    checkedAt: map.checkedAt,
    totalFree,
    middleFree,
    bestBlock,
    middleOk: bestBlock >= Math.max(1, policy.seatsTogether),
    hallRows,
    layoutSource: opts.layoutSource,
    goodRows,
    rows,
  };
}

/** Direction of seat numbers in a row as listed (left → right), or null if unclear. */
export function seatDirection(seats: { n: string }[]): 'asc' | 'desc' | null {
  const nums = seats.map((x) => Number.parseInt(x.n, 10)).filter(Number.isFinite);
  if (nums.length < 2) return null;
  return nums[nums.length - 1]! > nums[0]! ? 'asc' : nums[nums.length - 1]! < nums[0]! ? 'desc' : null;
}
