/**
 * Browser-free source: the same site APIs the browser source uses, sent as
 * plain HTTP with a real browser's TLS/HTTP fingerprint (impit), so the bot
 * check lets them through without running Chromium.
 *
 * Its name stays "ticketing": it reads the same data as the browser source,
 * so Redis state (baselines, dedupe markers, seat results) carries over.
 */
import { Impit } from 'impit';
import { log } from '../log.js';
import { BY_MOVIE_PATH, ByMovieError, byMovieHeaders, byMovieQueryString, parseByMovie, type ByMovieQuery, type ByMovieResult } from './by-movie.js';
import { bookingUrl, rateHintFrom, seatMapUrl, showtimesPath, snapshotFromResponse, type RateHint } from './site.js';
import {
  decryptSeatLayout,
  encryptedLayoutFrom,
  parseSeatLayout,
  SEAT_LAYOUT_ENDPOINT,
  seatLayoutRequest,
  seatRowsFromGrid,
  SeatsSoldOut,
} from './seat-layout.js';
import { BlockedError, type DateSnapshot, type SeatMap, type Show, type ShowSource, type VenueRef } from './types.js';

type Profile = NonNullable<ConstructorParameters<typeof Impit>[0]>['browser'];

export interface HttpSourceOptions {
  /** e.g. https://in.example.com — kept in .env, not in the repo */
  baseUrl: string;
  region: string;
  /** Browser fingerprints to use, tried in turn after a block (first = default) */
  profiles?: Profile[];
  timeoutMs?: number;
  /** AES key for seat layouts (defaults to the site's current one) */
  seatLayoutKey?: string;
  /**
   * Minimum gap between seat-layout requests, across all loops (default 3 s,
   * ≤ 20/min). Browser seat checks were slow enough to pace themselves; plain
   * HTTP is not, so this keeps the request rate near what the browser sent.
   */
  seatMinGapMs?: number;
}

const DEFAULT_PROFILES: Profile[] = ['firefox144', 'chrome', 'ios18'];

export class HttpSource implements ShowSource {
  readonly name = 'ticketing';
  private client!: Impit;
  private profileIndex = 0;
  private readonly profiles: Profile[];
  /** Last cache status seen on the showtimes API (HIT/MISS/…), for diagnostics */
  lastCacheStatus = '';
  /** Rate-limit hints from the last showtimes response, when the site sends them */
  lastRateHint: RateHint = {};
  /** Next time a seat-layout request may start; reserved before waiting, so parallel loops queue up. */
  private nextSeatAt = 0;

  constructor(private readonly opts: HttpSourceOptions) {
    this.profiles = opts.profiles?.length ? opts.profiles : DEFAULT_PROFILES;
  }

  get profile(): Profile {
    return this.profiles[this.profileIndex % this.profiles.length];
  }

  async init(): Promise<void> {
    this.client = new Impit({ browser: this.profile, timeout: this.opts.timeoutMs ?? 30_000 });
    log.info(`http source: browser fingerprint ${this.profile}`);
  }

  async fetchDate(venueRef: VenueRef, date: string, live = true): Promise<DateSnapshot> {
    const url = this.opts.baseUrl + showtimesPath(venueRef.code, date, this.opts.region, live);
    const res = await this.client.fetch(url, { headers: { accept: 'application/json, text/plain, */*' } });
    const text = await res.text();
    this.lastCacheStatus = res.headers.get('cf-cache-status') ?? '';
    this.lastRateHint = rateHintFrom((h) => res.headers.get(h));
    return snapshotFromResponse(
      { status: res.status, contentType: res.headers.get('content-type') ?? '', retryAfter: res.headers.get('retry-after') ?? '', text },
      date,
      { source: this.name, venue: venueRef.code },
    );
  }

  async fetchSeatMap(show: Show): Promise<SeatMap> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextSeatAt);
    this.nextSeatAt = startAt + (this.opts.seatMinGapMs ?? 3_000);
    if (startAt > now) await new Promise((r) => setTimeout(r, startAt - now));

    const { body, contentType } = seatLayoutRequest(show.venue, show.sessionId);
    const origin = new URL(this.opts.baseUrl).origin;
    const res = await this.client.fetch(SEAT_LAYOUT_ENDPOINT, {
      method: 'POST',
      body,
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': contentType,
        origin,
        referer: `${origin}/`,
        'x-app-code': 'WEB',
        'x-bms-id': `1.${Math.floor(Math.random() * 1e9)}.${Math.floor(Math.random() * 1e13)}`,
      },
    });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BlockedError(`seat layout: non-JSON response (HTTP ${res.status}, ${type || 'no content-type'})`, res.status);
    }
    if (res.status >= 400) {
      const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      throw new BlockedError(`seat layout: HTTP ${res.status}`, res.status, Number.isFinite(ra) ? ra : undefined);
    }

    const result = (rows: SeatMap['rows']): SeatMap => ({
      source: this.name,
      venue: show.venue,
      date: show.date,
      sessionId: show.sessionId,
      screen: show.screen,
      checkedAt: new Date().toISOString(),
      rows,
    });
    let encrypted: string;
    try {
      encrypted = encryptedLayoutFrom(json);
    } catch (err) {
      // Sold out is a valid "0 free" result (as the browser source reports it), so the
      // stored seats don't keep showing seats that are gone.
      if (err instanceof SeatsSoldOut) return result([]);
      throw err;
    }
    const grid = parseSeatLayout(decryptSeatLayout(encrypted, this.opts.seatLayoutKey));
    return result(seatRowsFromGrid(grid, show.categories));
  }

  /**
   * By-movie showtimes (all cinemas, one language, one date). A 429 is a rate
   * limit as usual; any other refusal or odd answer is a ByMovieError, so the
   * watcher can stop using this API without treating it as a bot check.
   */
  async fetchByMovie(q: Omit<ByMovieQuery, 'region'>): Promise<ByMovieResult> {
    const url = `${this.opts.baseUrl}${BY_MOVIE_PATH}?${byMovieQueryString({ ...q, region: this.opts.region })}`;
    const res = await this.client.fetch(url, { headers: byMovieHeaders(this.opts.region) });
    const text = await res.text();
    if (res.status === 429) {
      const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
      throw new BlockedError('by-movie: rate limited (HTTP 429)', 429, Number.isFinite(ra) ? ra : undefined);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ByMovieError(`by-movie: non-JSON response (HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'})`);
    }
    if (res.status >= 400 && !(json as { metadata?: { error?: unknown } })?.metadata?.error) {
      throw new ByMovieError(`by-movie: HTTP ${res.status}`);
    }
    return parseByMovie(json, q.date);
  }

  seatMapUrl(show: Show): string {
    return seatMapUrl(this.opts.baseUrl, this.opts.region, show);
  }

  bookingUrl(venue: VenueRef, date: string): string {
    return bookingUrl(this.opts.baseUrl, this.opts.region, venue, date);
  }

  /** After a block: fresh session (new cookies) with the next browser fingerprint. */
  async recover(): Promise<void> {
    this.profileIndex++;
    await this.init();
  }

  async close(): Promise<void> {}
}
