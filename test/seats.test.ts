import { describe, expect, it } from 'vitest';
import { analyseSeats, expandRows, learnedHall, pickGoodRows, type MiddlePolicy } from '../src/seats.js';
import type { SeatRow } from '../src/sources/types.js';

const POLICY: MiddlePolicy = { rowsFrom: 0.3, rowsTo: 0.85, centerWidth: 0.6, seatsTogether: 1 };
const HALL = expandRows('A-N');

/** Row with seats hi..1, `free` decides each seat. */
const row = (letter: string, hi: number, free: (n: number) => boolean): SeatRow => ({
  row: letter,
  category: 'GOLD',
  price: '295.00',
  seats: Array.from({ length: hi }, (_, i) => hi - i).map((n) => ({ n: String(n), free: free(n) })),
});

describe('rows', () => {
  it('expands ranges and lists', () => {
    expect(expandRows('A-E')).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(expandRows('A-H, J-K')).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K']);
    expect(expandRows('c,a,b')).toEqual(['C', 'A', 'B']);
  });

  it('keeps direction: "N-A" means N is at the screen', () => {
    expect(expandRows('E-A')).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(pickGoodRows(expandRows('N-A'), POLICY)).toEqual(['J', 'I', 'H', 'G', 'F', 'E', 'D', 'C']);
  });

  it('learned halls run from A to the furthest row seen', () => {
    expect(learnedHall(['K', 'L', 'M'])).toEqual(expandRows('A-M'));
  });

  it('picks the middle band of a 14-row hall (A front … N back)', () => {
    expect(pickGoodRows(HALL, POLICY)).toEqual(['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
  });
});

describe('analyseSeats', () => {
  it('real case: SCREEN 6 with only front rows A–D free is NOT a middle-seat show', () => {
    // Mirrors the live seat map seen for the 11:05 AM PCX show.
    const rows = [
      row('D', 45, (n) => n === 44),
      row('C', 41, (n) => n >= 37 || n <= 8),
      row('B', 39, (n) => n >= 27 || n <= 17),
      row('A', 34, () => true),
    ];
    const r = analyseSeats({ checkedAt: 't', rows }, { hallRows: HALL, layoutSource: 'config', policy: POLICY });
    expect(r.totalFree).toBe(1 + 13 + 30 + 34);
    expect(r.middleFree).toBe(0);
    expect(r.middleOk).toBe(false);
    expect(r.rows.map((x) => x.row)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('counts only the central share of a middle row', () => {
    // Row H, 20 seats, all free → central 60% = seats 5..16 (12 seats).
    const r = analyseSeats({ checkedAt: 't', rows: [row('H', 20, () => true)] }, { hallRows: HALL, layoutSource: 'config', policy: POLICY });
    expect(r.middleFree).toBe(12);
    expect(r.bestBlock).toBe(12);
    expect(r.middleOk).toBe(true);
    const mids = r.rows[0]!.seats.filter((s) => s.middle).map((s) => Number(s.n)).sort((a, b) => a - b);
    expect(mids).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('keeps the site order (left → right) whichever way the hall is numbered', () => {
    const asc: SeatRow = { row: 'H', category: 'X', price: '1', seats: [1, 2, 3, 4, 5].map((n) => ({ n: String(n), free: true })) };
    const desc: SeatRow = { ...asc, seats: [...asc.seats].reverse() };
    const opts = { hallRows: HALL, layoutSource: 'config' as const, policy: POLICY };
    expect(analyseSeats({ checkedAt: 't', rows: [asc] }, opts).rows[0]!.seats.map((s) => s.n)).toEqual(['1', '2', '3', '4', '5']);
    const d = analyseSeats({ checkedAt: 't', rows: [desc] }, opts).rows[0]!;
    expect(d.seats.map((s) => s.n)).toEqual(['5', '4', '3', '2', '1']);
    expect(d.seats.filter((s) => s.middle).map((s) => s.n)).toEqual(['4', '3', '2']);
  });

  it('side seats in a middle row do not count', () => {
    const r = analyseSeats({ checkedAt: 't', rows: [row('H', 20, (n) => n <= 3 || n >= 18)] }, { hallRows: HALL, layoutSource: 'config', policy: POLICY });
    expect(r.totalFree).toBe(6);
    expect(r.middleOk).toBe(false);
  });

  it('seatsTogether requires adjacent middle seats', () => {
    const scattered = [row('H', 20, (n) => n === 8 || n === 10 || n === 12)];
    const p2 = { ...POLICY, seatsTogether: 2 };
    const a = analyseSeats({ checkedAt: 't', rows: scattered }, { hallRows: HALL, layoutSource: 'config', policy: p2 });
    expect(a.bestBlock).toBe(1);
    expect(a.middleOk).toBe(false);
    const pair = [row('H', 20, (n) => n === 10 || n === 11)];
    expect(analyseSeats({ checkedAt: 't', rows: pair }, { hallRows: HALL, layoutSource: 'config', policy: p2 }).middleOk).toBe(true);
  });

  it('explicit goodRows override the depth band', () => {
    const r = analyseSeats(
      { checkedAt: 't', rows: [row('C', 20, () => true)] },
      { hallRows: HALL, layoutSource: 'config', policy: POLICY, goodRowsOverride: ['c', 'd'] },
    );
    expect(r.goodRows).toEqual(['C', 'D']);
    expect(r.middleOk).toBe(true);
  });

  it('reversed hall (row A at the back): front rows near the screen are not middle', () => {
    // SCREEN 1 style: M at the screen, A at the back; only L/M (front) have seats.
    const hall = expandRows('M-A');
    const rows = [row('M', 26, () => true), row('L', 28, (n) => n <= 9 || n >= 21)];
    const r = analyseSeats({ checkedAt: 't', rows }, { hallRows: hall, layoutSource: 'config', policy: POLICY });
    expect(r.goodRows).toEqual(['I', 'H', 'G', 'F', 'E', 'D', 'C']);
    expect(r.middleOk).toBe(false);
    expect(r.rows.map((x) => x.row)).toEqual(['M', 'L']);
  });

  it('rows missing from the configured hall are appended at the back', () => {
    const r = analyseSeats({ checkedAt: 't', rows: [row('Z', 10, () => true)] }, { hallRows: ['A', 'C'], layoutSource: 'learned', policy: POLICY });
    expect(r.hallRows).toEqual(['A', 'C', 'Z']);
  });
});
