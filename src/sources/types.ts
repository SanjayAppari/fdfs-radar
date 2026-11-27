/**
 * Pluggable source interface. Every ticketing source (the current venue API,
 * prasadz.com, District, ...) normalises its data into these shapes so the
 * diff + notifier never care where a show came from.
 */

export interface SeatCategory {
  /** e.g. "EXECUTIVE", "GOLD" */
  name: string;
  price: string;
  /** "1" = available */
  availStatus: string;
}

export interface Show {
  source: string;
  venue: string;
  /** YYYYMMDD */
  date: string;
  sessionId: string;
  /** Parent title, e.g. "Avengers: Doomsday" (used for movie keyword match) */
  movie: string;
  /** Child event name, e.g. "Avengers: Doomsday (MS-Infinity Vsn 3D) - English" */
  eventName: string;
  eventCode: string;
  /** e.g. "2D", "MS-Infinity Vsn 3d", "HDR By Barco" */
  dimension: string;
  screen: string;
  attributes: string;
  /** Display time, e.g. "08:00 AM" */
  time: string;
  /** YYYYMMDDHHmm */
  showDateTime: string;
  /** "1" = available */
  availStatus: string;
  /** Seat classes with price + availability (empty if the source doesn't say) */
  categories: SeatCategory[];
}

export interface SeatRow {
  /** Row letter as printed in the hall, e.g. "D" */
  row: string;
  /** Seat class, e.g. "GOLD" */
  category: string;
  price: string;
  /** Every seat in the row, in the order the site lists them (left → right facing the screen) */
  seats: { n: string; free: boolean }[];
}

/**
 * Seat-level availability for one show. Only rows that still have at least
 * one free seat are listed by the site; fully booked rows are absent.
 */
export interface SeatMap {
  source: string;
  venue: string;
  date: string;
  sessionId: string;
  screen: string;
  checkedAt: string;
  rows: SeatRow[];
}

export type DateStatus = 'open' | 'not_open' | 'venue_down';

export interface DateSnapshot {
  source: string;
  venue: string;
  /** YYYYMMDD that was requested */
  date: string;
  status: DateStatus;
  /** Dates the source reports as bookable (null if the response didn't say) */
  openDates: string[] | null;
  shows: Show[];
}

export interface ShowSource {
  readonly name: string;
  init(): Promise<void>;
  fetchDate(date: string): Promise<DateSnapshot>;
  /** Called after a block / repeated errors: refresh session, reload page, etc. */
  recover(): Promise<void>;
  /** Optional: seat-level availability for one show. */
  fetchSeatMap?(show: Show): Promise<SeatMap>;
  /** Public booking link for a date, used in alerts */
  bookingUrl(date: string): string;
  close(): Promise<void>;
}

/** Thrown when the source answers with a bot-challenge / non-JSON page. */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

/** Seat map could not be read for this show (redirected, not offered); not a fault. */
export class SeatMapUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatMapUnavailable';
  }
}
