import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decryptSeatLayout,
  encryptedLayoutFrom,
  parseSeatLayout,
  SeatLayoutFormatError,
  seatLayoutRequest,
  SeatsSoldOut,
  seatRowsFromGrid,
} from '../src/sources/seat-layout.js';
import { SeatMapUnavailable } from '../src/sources/types.js';
import { detectRowOrder, orderOfSpec, seatDirection } from '../src/seats.js';

/** Raw seat-layout responses captured from the site (still encrypted). */
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/seat-layout-${name.includes('-') ? name : `PRHN-${name}`}.json`, import.meta.url)), 'utf8'));
const gridOf = (screen: string) => parseSeatLayout(decryptSeatLayout(encryptedLayoutFrom(fixture(screen))));

describe('seat layout: decrypt + parse', () => {
  it('decrypts the captured Screen 4 layout and counts its seats', () => {
    const grid = gridOf('SCREEN4');
    expect(grid.areas).toEqual([{ id: 'A', name: 'EXECUTIVE', code: '0000000002' }]);
    const seats = grid.rows.flatMap((r) => r.seats);
    expect(seats.filter((s) => s.free)).toHaveLength(56);
    expect(seats.filter((s) => !s.free)).toHaveLength(334);
    expect(grid.rows.map((r) => r.row)).toEqual('ABCDEFGHIJKLMN'.split(''));
  });

  it('keeps aisle gaps as column positions', () => {
    const b = gridOf('SCREEN4').rows.find((r) => r.row === 'B')!;
    const s14 = b.seats.find((s) => s.n === '14')!;
    const s15 = b.seats.find((s) => s.n === '15')!;
    expect(s15.col - s14.col).toBe(3); // two empty columns between them
  });

  it('keeps blank lines in the line numbering (Screen 4 has a gap line after F)', () => {
    const rows = gridOf('SCREEN4').rows;
    const f = rows.find((r) => r.row === 'F')!;
    const g = rows.find((r) => r.row === 'G')!;
    expect(g.line - f.line).toBe(2);
  });

  it('agrees with config.json on hall direction for both captured halls', () => {
    // Screen 4: rows "N-A" (N at the screen), seats asc. Screen 6: rows "A-N", seats desc.
    for (const [screen, rows, ltr] of [
      ['SCREEN4', 'N-A', 'asc'],
      ['SCREEN6', 'A-N', 'desc'],
    ] as const) {
      const seatRows = seatRowsFromGrid(gridOf(screen));
      expect(detectRowOrder(seatRows)).toBe(orderOfSpec(rows));
      const full = seatRows.reduce((a, b) => (b.seats.length > a.seats.length ? b : a));
      expect(seatDirection(full.seats)).toBe(ltr);
    }
  });

  it('names PVR classes via the show\'s area codes (layout only says "CR")', () => {
    const rows = seatRowsFromGrid(gridOf('ILKS-PXL'), [
      { name: 'CLASSIC ROWS', price: '359.00', availStatus: '1', code: 'CR' },
      { name: 'RECLINER ROWS', price: '418.00', availStatus: '0', code: 'BR' },
    ]);
    const names = new Set(rows.map((r) => r.category));
    expect(names.has('CLASSIC ROWS')).toBe(true);
    expect(names.has('RECLINER ROWS')).toBe(true);
    expect(rows.find((r) => r.category === 'CLASSIC ROWS')!.price).toBe('359.00');
    expect(names.has('QR')).toBe(true); // no class given for it: falls back to the layout's name
  });

  it('maps rows to SeatRow with category and price from the show', () => {
    const rows = seatRowsFromGrid(gridOf('SCREEN6'), [{ name: 'GOLD', price: '295.00', availStatus: '1' }]);
    expect(rows[0]).toMatchObject({ row: 'N', category: 'GOLD', price: '295.00' });
    expect(rows.every((r) => r.seats.every((s) => /^\d+$/.test(s.n)))).toBe(true);
  });

  it('reads the short seat format (PVR Lakeshore: `A201`, no "+number")', () => {
    const grid = gridOf('ILKS-PXL');
    expect(grid.areas.map((a) => a.id)).toEqual(['A', 'B', 'C', 'D']);
    const q = grid.rows[0]!;
    expect(q.row).toBe('Q');
    expect(q.seats.slice(0, 3).map((s) => s.n)).toEqual(['01', '02', '03']); // labelled as the site shows them
    expect(q.seats[2]!.col - q.seats[1]!.col).toBe(8); // aisle of 7 empty columns
    const seats = grid.rows.flatMap((r) => r.seats);
    expect(seats.length).toBeGreaterThan(100);
    expect(seats.every((s) => /^\d{2}$/.test(s.n))).toBe(true);
  });

  it('agrees with config.json on hall direction for PVR Lakeshore PXL Audi 6', () => {
    // config: rows "A-H,J-N,P-Q" (A at the screen), seats asc.
    const seatRows = seatRowsFromGrid(gridOf('ILKS-PXL'));
    expect(detectRowOrder(seatRows)).toBe(orderOfSpec('A-H,J-N,P-Q'));
    const full = seatRows.reduce((a, b) => (b.seats.length > a.seats.length ? b : a));
    expect(seatDirection(full.seats)).toBe('asc');
  });

  it('passes an already-decrypted layout straight through', () => {
    const plain = 'GOLD:A:0003:1:N:0||1:A:A000:A1011+1:A0+0:A2013+2|';
    const grid = parseSeatLayout(decryptSeatLayout(plain));
    expect(grid.rows[0]!.seats).toEqual([
      { n: '1', free: true, status: '1', areaId: 'A', col: 0 },
      { n: '2', free: false, status: '2', areaId: 'A', col: 2 },
    ]);
  });

  it('treats status 4 ("best seat") as free and unknown statuses as not free', () => {
    const grid = parseSeatLayout('GOLD:A:0003:1:N:0||1:A:A000:A4011+1:A3012+2|');
    expect(grid.rows[0]!.seats.map((s) => s.free)).toEqual([true, false]);
  });

  it('splits a row that spans two seat classes', () => {
    const grid = parseSeatLayout('GOLD:A:1|SILVER:B:2||1:C:A000:A1011+1:B1012+2|');
    expect(seatRowsFromGrid(grid).map((r) => [r.row, r.category, r.seats.length])).toEqual([
      ['C', 'GOLD', 1],
      ['C', 'SILVER', 1],
    ]);
  });
});

describe('seat layout: errors', () => {
  it('"sold out" is its own result (0 free), still a SeatMapUnavailable for callers that only skip', () => {
    const soldOut = { BookMyShow: { blnSuccess: 'false', strException: "It seems seats are sold out hence we can't proceed further. Please check another show. (#159)" } };
    expect(() => encryptedLayoutFrom(soldOut)).toThrow(SeatsSoldOut);
    expect(() => encryptedLayoutFrom(soldOut)).toThrow(SeatMapUnavailable);
  });

  it('a refusal from the site is SeatMapUnavailable (skip, not an error)', () => {
    const closed = { BookMyShow: { blnSuccess: 'false', strException: 'Show closed' } };
    expect(() => encryptedLayoutFrom(closed)).toThrow(SeatMapUnavailable);
    expect(() => encryptedLayoutFrom(closed)).not.toThrow(SeatsSoldOut);
  });

  it('a wrong key is a format error, not a block', () => {
    const data = encryptedLayoutFrom(fixture('SCREEN4'));
    expect(() => decryptSeatLayout(data, 'x'.repeat(32))).toThrow(SeatLayoutFormatError);
  });

  it('an unknown envelope is a format error', () => {
    expect(() => encryptedLayoutFrom({ something: 'else' })).toThrow(SeatLayoutFormatError);
  });

  it('a layout with no readable seat is a format error (so the browser takes over)', () => {
    expect(() => parseSeatLayout('GOLD:A:1||1:A:A000:A0+0|')).toThrow(SeatLayoutFormatError);
  });
});

describe('seat layout request', () => {
  it('builds the multipart body the web client sends', () => {
    const { body, contentType } = seatLayoutRequest('PRHN', '259268');
    const boundary = contentType.split('boundary=')[1]!;
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
    expect(body).toContain('name="strCommand"\r\n\r\nGETSEATLAYOUT\r\n');
    expect(body).toContain('name="strVenueCode"\r\n\r\nPRHN\r\n');
    expect(body).toContain('name="strParam1"\r\n\r\n259268\r\n');
  });
});
