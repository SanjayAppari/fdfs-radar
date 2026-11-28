/**
 * SOURCE=auto: plain HTTP first, the browser when HTTP stops working.
 *
 * Showtimes and seat maps fall back separately (a changed seat-layout key
 * only breaks seat maps). A failure the browser can get past (bot check,
 * unreadable seat layout) moves that job to the browser and retries the same
 * call there at once, so nothing is missed. Rate limits (429) are per
 * connection, so they are passed on unchanged for the normal back-off.
 * HTTP is tried again after 30 min, then 1 h, 2 h, 4 h (max).
 */
import { log } from '../log.js';
import { SeatLayoutFormatError } from './seat-layout.js';
import { BlockedError, type DateSnapshot, type SeatMap, type Show, type ShowSource, type VenueRef } from './types.js';

export type Job = 'showtimes' | 'seats';

export interface SwitchEvent {
  job: Job;
  to: 'http' | 'browser';
  /** Why it switched (to browser), or how long the browser was used (back to http) */
  reason: string;
  /** When HTTP will be tried again (switches to browser only) */
  retryAt?: number;
}

export interface FallbackOptions {
  /** Called on every switch, e.g. to send a Telegram message. Errors are logged, not thrown. */
  onSwitch?: (e: SwitchEvent) => Promise<void> | void;
  firstRetryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
}

interface JobState {
  on: 'http' | 'browser';
  since: number;
  retryAt: number;
  retryMs: number;
}

const firstLine = (err: unknown) => (err as Error).message.split('\n')[0]!;

/** A failure that the browser can get past. */
export function browserCanHelp(err: unknown): boolean {
  if (err instanceof SeatLayoutFormatError) return true;
  return err instanceof BlockedError && err.httpStatus !== 429;
}

export class FallbackSource implements ShowSource {
  readonly name: string;
  private readonly state: Record<Job, JobState>;
  private browserReady?: Promise<void>;
  private readonly now: () => number;
  private readonly firstRetryMs: number;
  private readonly maxRetryMs: number;
  /** Which source served the last showtimes request (for its rate hints) */
  private lastShowtimes: ShowSource;

  constructor(
    private readonly http: ShowSource,
    private readonly browser: ShowSource,
    private readonly opts: FallbackOptions = {},
  ) {
    if (http.name !== browser.name) throw new Error('both sources must share one name (Redis keys depend on it)');
    this.name = http.name;
    this.now = opts.now ?? Date.now;
    this.firstRetryMs = opts.firstRetryMs ?? 30 * 60_000;
    this.maxRetryMs = opts.maxRetryMs ?? 4 * 60 * 60_000;
    const fresh = (): JobState => ({ on: 'http', since: 0, retryAt: 0, retryMs: this.firstRetryMs });
    this.state = { showtimes: fresh(), seats: fresh() };
    this.lastShowtimes = http;
  }

  get lastRateHint() {
    return this.lastShowtimes.lastRateHint;
  }

  /** Where each job currently runs (for logs / status) */
  get mode(): Record<Job, 'http' | 'browser'> {
    return { showtimes: this.state.showtimes.on, seats: this.state.seats.on };
  }

  async init(): Promise<void> {
    await this.http.init();
  }

  fetchDate(venue: VenueRef, date: string, live?: boolean): Promise<DateSnapshot> {
    return this.run('showtimes', (s) => {
      this.lastShowtimes = s;
      return s.fetchDate(venue, date, live);
    });
  }

  fetchSeatMap(show: Show, slot?: 'seat' | 'hot'): Promise<SeatMap> {
    return this.run('seats', (s) => s.fetchSeatMap!(show, slot));
  }

  seatMapUrl(show: Show): string {
    return this.http.seatMapUrl?.(show) ?? this.browser.seatMapUrl!(show);
  }

  bookingUrl(venue: VenueRef, date: string): string {
    return this.http.bookingUrl(venue, date);
  }

  /** After a block both get a fresh session; the browser only if it's running. */
  async recover(): Promise<void> {
    await this.http.recover();
    if (this.browserReady) await this.browser.recover();
  }

  async close(): Promise<void> {
    await this.http.close();
    if (this.browserReady) await this.browser.close();
  }

  private async run<T>(job: Job, call: (s: ShowSource) => Promise<T>): Promise<T> {
    const st = this.state[job];

    if (st.on === 'browser') {
      if (this.now() < st.retryAt) return call(await this.startBrowser());
      // Time to test HTTP again. The next retry is reserved first, so parallel
      // calls keep using the browser while this one tests.
      st.retryMs = Math.min(st.retryMs * 2, this.maxRetryMs);
      st.retryAt = this.now() + st.retryMs;
      try {
        const result = await call(this.http);
        const mins = Math.round((this.now() - st.since) / 60_000);
        Object.assign(st, { on: 'http', since: this.now(), retryAt: 0, retryMs: this.firstRetryMs });
        log.info(`${job}: plain HTTP works again, leaving the browser (used ${mins} min)`);
        await this.notify({ job, to: 'http', reason: `browser was used for ${mins} min` });
        return result;
      } catch (err) {
        if (!browserCanHelp(err)) throw err;
        log.warn(`${job}: plain HTTP still fails (${firstLine(err)}); browser for another ${Math.round(st.retryMs / 60_000)} min`);
        return call(await this.startBrowser());
      }
    }

    try {
      return await call(this.http);
    } catch (err) {
      if (!browserCanHelp(err)) throw err;
      if (st.on === 'http') {
        // (Re-checked: a parallel call may have switched this job already.)
        Object.assign(st, { on: 'browser', since: this.now(), retryAt: this.now() + st.retryMs });
        log.warn(`${job}: plain HTTP failed (${firstLine(err)}); switching to the browser`);
        await this.notify({ job, to: 'browser', reason: firstLine(err), retryAt: st.retryAt });
      }
      return call(await this.startBrowser());
    }
  }

  private startBrowser(): Promise<ShowSource> {
    this.browserReady ??= this.browser.init().catch((err) => {
      this.browserReady = undefined; // try again next time
      throw new Error(`browser fallback could not start: ${(err as Error).message}`);
    });
    return this.browserReady.then(() => this.browser);
  }

  private async notify(e: SwitchEvent): Promise<void> {
    try {
      await this.opts.onSwitch?.(e);
    } catch (err) {
      log.error(`switch notification failed: ${(err as Error).message}`);
    }
  }
}
