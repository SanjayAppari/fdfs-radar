/**
 * The site's seat-layout endpoint (what its own web client calls): request
 * body, response envelope, AES decryption and the decrypted grid format.
 * Pure; unit-tested against captured responses in fixtures/.
 *
 * Decrypted format: `<areas>||<rows>`
 *   areas: `NAME:areaId:areaCode:...` joined by `|`, e.g. `EXECUTIVE:A:0000000002:1:N:0`
 *   rows:  `rowNo:LABEL:<marker>:<seat>:<seat>…` joined by `|`, top → bottom as
 *          drawn (screen at the bottom). Seats are left → right as drawn.
 *   seat:  `<areaId><status><grid>+<number>`, e.g. `A2011+1`; `A0+0` is a gap.
 *          status 1 = free, 4 = free ("best seat"), 2 = booked, 0 = gap,
 *          anything else = not sellable (held/blocked).
 */
import { createDecipheriv, randomUUID } from 'node:crypto';
import { SeatMapUnavailable, type SeatCategory, type SeatRow } from './types.js';

/** The key the site's web client uses; override with SEAT_LAYOUT_KEY if it ever changes. */
export const DEFAULT_SEAT_LAYOUT_KEY = 'kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z';

export const SEAT_LAYOUT_ENDPOINT = 'https://services-in.bookmyshow.com/doTrans.aspx';

/** The layout could not be decrypted or read: the key or format changed. Not a block. */
export class SeatLayoutFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatLayoutFormatError';
  }
}

export function seatLayoutRequest(venue: string, sessionId: string): { body: string; contentType: string } {
  const fields: Record<string, string> = {
    strAppCode: 'WEB',
    lngTransactionIdentifier: '0',
    strCommand: 'GETSEATLAYOUT',
    strVenueCode: venue,
    strParam1: sessionId,
    strParam2: 'WEB',
    strParam3: '',
    strParam4: '',
    strParam5: 'Y',
    strParam6: 'N',
    strParam7: 'N',
    strParam8: '',
    strParam9: '',
    strParam10: '',
    strFormat: 'json',
  };
  const boundary = `----fdfs${randomUUID().replace(/-/g, '')}`;
  const body =
    Object.entries(fields)
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('') + `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The encrypted layout from a parsed response. A refusal (show closed, bad
 * session…) is SeatMapUnavailable: the seat check is skipped, not an error.
 */
export function encryptedLayoutFrom(json: unknown): string {
  const env = (json as { BookMyShow?: Record<string, unknown> } | null)?.BookMyShow;
  if (!env) throw new SeatLayoutFormatError('seat layout response has no envelope');
  if (String(env.blnSuccess).toLowerCase() !== 'true') {
    throw new SeatMapUnavailable(`site refused the seat layout: ${String(env.strException || 'no reason given').slice(0, 160)}`);
  }
  if (typeof env.strData !== 'string' || !env.strData) throw new SeatLayoutFormatError('seat layout response has no data');
  return env.strData;
}

/** AES-256-CBC, zero IV, PKCS7. Plain (already decrypted) layouts pass through. */
export function decryptSeatLayout(data: string, key: string = DEFAULT_SEAT_LAYOUT_KEY): string {
  if (data.includes('||')) return data;
  let text: string;
  try {
    const d = createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.alloc(16));
    text = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch (err) {
    throw new SeatLayoutFormatError(`seat layout could not be decrypted (has the key changed?): ${(err as Error).message}`);
  }
  if (!text.includes('||')) throw new SeatLayoutFormatError('decrypted seat layout has an unknown format');
  return text;
}

export interface GridSeat {
  n: string;
  free: boolean;
  /** Raw status digit (1/4 free, 2 booked, other = not sellable) */
  status: string;
  areaId: string;
  /** Column as drawn, gaps included (0 = leftmost column of the layout) */
  col: number;
}

export interface GridRow {
  row: string;
  /** Line as drawn, top → bottom, gap lines included */
  line: number;
  seats: GridSeat[];
}

export interface SeatGrid {
  areas: { id: string; name: string; code: string }[];
  /** Rows that have seats, top → bottom as drawn (the screen is at the bottom) */
  rows: GridRow[];
  cols: number;
  lines: number;
}

export function parseSeatLayout(text: string): SeatGrid {
  const [areaPart, rowPart] = text.split('||', 2);
  if (rowPart === undefined) throw new SeatLayoutFormatError('seat layout has no rows section');

  const areas = areaPart!
    .split('|')
    .filter(Boolean)
    .map((a) => {
      const [name = '', id = '', code = ''] = a.split(':');
      return { id, name: name.trim(), code };
    });

  const rows: GridRow[] = [];
  let cols = 0;
  const lines = rowPart.split('|').filter(Boolean);
  lines.forEach((raw, line) => {
    const [, label = '', ...rest] = raw.split(':');
    // The first field after the label is a marker without a seat number; seats all carry "+".
    const cells = rest.filter((c) => c.includes('+'));
    cols = Math.max(cols, cells.length);
    const seats: GridSeat[] = [];
    cells.forEach((cell, col) => {
      const [token = '', number = ''] = cell.split('+');
      const status = token[1] ?? '0';
      if (status === '0') return; // gap / aisle
      seats.push({
        n: number && number !== '0' ? number.replace(/^0+(?=.)/, '') : token.slice(2),
        free: status === '1' || status === '4',
        status,
        areaId: token[0] ?? '',
        col,
      });
    });
    if (label.trim() && seats.length) rows.push({ row: label.trim(), line, seats });
  });
  if (!rows.length) throw new SeatMapUnavailable('seat layout has no seats (the show may be closed)');
  return { areas, rows, cols, lines: lines.length };
}

/**
 * The grid as the watcher's SeatRow[]: one entry per row and seat class, in
 * drawn order (rows top → bottom, seats left → right). Unlike the browser
 * source, fully booked rows are included, so totals cover the whole hall.
 * Prices come from the show's categories, matched by class name.
 */
export function seatRowsFromGrid(grid: SeatGrid, categories: SeatCategory[] = []): SeatRow[] {
  const areaName = new Map(grid.areas.map((a) => [a.id, a.name]));
  const price = new Map(categories.map((c) => [c.name.trim().toUpperCase(), c.price]));
  const out: SeatRow[] = [];
  for (const r of grid.rows) {
    const byArea = new Map<string, SeatRow>();
    for (const s of r.seats) {
      const category = areaName.get(s.areaId) ?? s.areaId;
      let row = byArea.get(category);
      if (!row) {
        row = { row: r.row, category, price: price.get(category.toUpperCase()) ?? '', seats: [] };
        byArea.set(category, row);
        out.push(row);
      }
      row.seats.push({ n: s.n, free: s.free });
    }
  }
  return out;
}
