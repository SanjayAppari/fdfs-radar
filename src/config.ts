import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MiddlePolicy, ScreenOverride } from './seats.js';

export interface PollConfig {
  /** Seconds between rounds (each watched date once per round), random in [min, max] */
  minSeconds: number;
  maxSeconds: number;
  /** Seconds between dates inside one round */
  gapMinSeconds: number;
  gapMaxSeconds: number;
  /** Back-off after a block, in minutes, random in [min, max] */
  blockedBackoffMinMinutes: number;
  blockedBackoffMaxMinutes: number;
  /** Reload the venue page this often to refresh cookies */
  reloadEveryMinutes: number;
  /** Showtime fetches run in parallel batches of this size (keep 1 when polling live) */
  concurrency: number;
  /** Dates fetched live (no CDN cache) every round; empty = the first two configured dates */
  liveDates: string[];
  /** Other dates are fetched (from the CDN cache) every N rounds */
  otherEveryRounds: number;
}

export interface SeatConfig {
  enabled: boolean;
  /** Telegram alert when a watched show gets free middle seats */
  alertMiddle: boolean;
  /** Max seat maps to read per polling round */
  perRound: number;
  /** Re-read a show's seat map at most this often */
  minIntervalMinutes: number;
  middle: MiddlePolicy;
  /** 🔓 alert when a row with no free seats at the last check now has at least `rowUnlockMinSeats` */
  alertRowsOpened: boolean;
  rowUnlockMinSeats: number;
  /** 🎯 alert again when an already-green show gains at least this many middle seats (0 = off) */
  alertIncrease: number;
  /** Repeat 🎯 alerts for the same show at most this often */
  alertCooldownMinutes: number;
  /** Fast loop: re-read a few "hot" shows every few seconds in a dedicated tab */
  fast: FastConfig;
}

export interface FastConfig {
  enabled: boolean;
  /** How many shows the fast loop cycles through */
  maxShows: number;
  /** Target seconds between re-reads of the same hot show */
  intervalSeconds: number;
  /** Optional filters; empty = any. Shows in priority formats and earlier dates are picked first. */
  venues: string[];
  dates: string[];
  formats: string[];
}

export interface VenueConfig {
  /** Display name used in alerts, e.g. "AMB Cinemas" */
  name: string;
  /** Site venue code, e.g. "PRHN" */
  code: string;
  /** Slug from the venue page link, e.g. "prasads-multiplex-hyderabad" */
  slug: string;
  /** Dates for this venue (YYYYMMDD); defaults to the top-level dates */
  dates: string[];
  /** Movie keywords for this venue; defaults to the top-level movies */
  movies: string[];
  /** Only shows whose screen/format/attributes match one of these (e.g. ["PXL"]); empty = all */
  formats: string[];
  /** Per-screen layout hints, keyed by screen name as shown, e.g. "SCREEN 6" */
  screens: Record<string, ScreenOverride>;
}

export interface WatchConfig {
  region: string;
  venues: VenueConfig[];
  /** Union of every venue's dates (YYYYMMDD) */
  dates: string[];
  /** Case-insensitive keywords matched against the movie title. Empty = every movie. */
  movies: string[];
  /** Case-insensitive keywords matched against show attributes or format. */
  priorityFormats: string[];
  poll: PollConfig;
  seats: SeatConfig;
}

const DEFAULT_SEATS: SeatConfig = {
  enabled: true,
  alertMiddle: true,
  perRound: 3,
  minIntervalMinutes: 5,
  middle: { rowsFrom: 0.3, rowsTo: 0.85, centerWidth: 0.6, seatsTogether: 1 },
  alertRowsOpened: true,
  rowUnlockMinSeats: 1,
  alertIncrease: 4,
  alertCooldownMinutes: 10,
  fast: { enabled: true, maxShows: 4, intervalSeconds: 20, venues: [], dates: [], formats: [] },
};

function parseSeats(raw: unknown): SeatConfig {
  const r = (raw ?? {}) as Partial<SeatConfig> & { middle?: Partial<MiddlePolicy> };
  const middle = { ...DEFAULT_SEATS.middle, ...(r.middle ?? {}) };
  const frac = (v: number, k: string) => {
    if (!(v >= 0 && v <= 1)) throw new Error(`seats.middle.${k} must be between 0 and 1`);
  };
  frac(middle.rowsFrom, 'rowsFrom');
  frac(middle.rowsTo, 'rowsTo');
  frac(middle.centerWidth, 'centerWidth');
  if (middle.rowsFrom > middle.rowsTo) throw new Error('seats.middle.rowsFrom must be <= rowsTo');
  return {
    enabled: r.enabled ?? DEFAULT_SEATS.enabled,
    alertMiddle: r.alertMiddle ?? DEFAULT_SEATS.alertMiddle,
    perRound: r.perRound ?? DEFAULT_SEATS.perRound,
    minIntervalMinutes: r.minIntervalMinutes ?? DEFAULT_SEATS.minIntervalMinutes,
    middle,
    alertRowsOpened: r.alertRowsOpened ?? DEFAULT_SEATS.alertRowsOpened,
    rowUnlockMinSeats: r.rowUnlockMinSeats ?? DEFAULT_SEATS.rowUnlockMinSeats,
    alertIncrease: r.alertIncrease ?? DEFAULT_SEATS.alertIncrease,
    alertCooldownMinutes: r.alertCooldownMinutes ?? DEFAULT_SEATS.alertCooldownMinutes,
    fast: parseFast((r as { fast?: unknown }).fast),
  };
}

function parseFast(raw: unknown): FastConfig {
  const f = (raw ?? {}) as Partial<FastConfig>;
  const d = DEFAULT_SEATS.fast;
  const fast: FastConfig = {
    enabled: f.enabled ?? d.enabled,
    maxShows: f.maxShows ?? d.maxShows,
    intervalSeconds: f.intervalSeconds ?? d.intervalSeconds,
    venues: strings(f.venues, 'seats.fast.venues').map((v) => v.toUpperCase()),
    dates: strings(f.dates, 'seats.fast.dates').map(normaliseDate),
    formats: strings(f.formats, 'seats.fast.formats'),
  };
  if (fast.maxShows < 0 || fast.maxShows > 12) throw new Error('seats.fast.maxShows must be 0–12');
  if (fast.intervalSeconds < 5) throw new Error('seats.fast.intervalSeconds must be at least 5');
  return fast;
}

const parseScreens = (raw: unknown): Record<string, ScreenOverride> => {
  const out: Record<string, ScreenOverride> = {};
  for (const [name, o] of Object.entries((raw ?? {}) as Record<string, ScreenOverride>)) out[name.trim().toUpperCase()] = o;
  return out;
};

const DEFAULT_POLL: PollConfig = {
  minSeconds: 10,
  maxSeconds: 15,
  gapMinSeconds: 0.3,
  gapMaxSeconds: 0.8,
  blockedBackoffMinMinutes: 5,
  blockedBackoffMaxMinutes: 10,
  reloadEveryMinutes: 45,
  concurrency: 1,
  liveDates: [],
  otherEveryRounds: 6,
};

/** Accepts "20261217" or "2026-12-17". */
export function normaliseDate(input: string): string {
  const s = String(input).trim().replaceAll('-', '');
  if (!/^\d{8}$/.test(s)) throw new Error(`invalid date "${input}" (use YYYYMMDD or YYYY-MM-DD)`);
  return s;
}

const strings = (v: unknown, field: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`config.${field} must be an array of strings`);
  }
  return v.map((x) => x.trim()).filter(Boolean);
};

const requiredString = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`config.${field} is required`);
  return v.trim();
};

const dateList = (v: unknown, field: string) => [...new Set(strings(v, field).map(normaliseDate))].sort();

export function parseConfig(raw: unknown): WatchConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const c = raw as Record<string, unknown>;
  const topDates = dateList(c.dates, 'dates');
  const topMovies = strings(c.movies, 'movies');

  const rawPoll = (c.poll as Partial<PollConfig>) ?? {};
  const poll: PollConfig = {
    ...DEFAULT_POLL,
    ...rawPoll,
    liveDates: rawPoll.liveDates ? strings(rawPoll.liveDates, 'poll.liveDates').map(normaliseDate) : [],
  };
  if (poll.minSeconds > poll.maxSeconds) throw new Error('poll.minSeconds must be <= poll.maxSeconds');
  if (!(poll.concurrency >= 1 && poll.concurrency <= 6)) throw new Error('poll.concurrency must be 1–6');

  // New format: venues[]. Old single-venue format (venue/venueSlug/venueName + seats.screens) still loads.
  const rawVenues: Record<string, unknown>[] = Array.isArray(c.venues)
    ? (c.venues as Record<string, unknown>[])
    : c.venue
      ? [{ name: c.venueName, code: c.venue, slug: c.venueSlug, screens: (c.seats as { screens?: unknown } | undefined)?.screens }]
      : [];
  if (rawVenues.length === 0) throw new Error('config.venues must list at least one venue');

  const venues: VenueConfig[] = rawVenues.map((v, i) => {
    const code = requiredString(v.code, `venues[${i}].code`).toUpperCase();
    const dates = v.dates !== undefined ? dateList(v.dates, `venues[${i}].dates`) : topDates;
    if (dates.length === 0) throw new Error(`no dates for venue ${code} (set config.dates or venues[${i}].dates)`);
    return {
      code,
      name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : code,
      slug: requiredString(v.slug, `venues[${i}].slug`),
      dates,
      movies: v.movies !== undefined ? strings(v.movies, `venues[${i}].movies`) : topMovies,
      formats: strings(v.formats, `venues[${i}].formats`),
      screens: parseScreens(v.screens),
    };
  });
  const codes = venues.map((v) => v.code);
  if (new Set(codes).size !== codes.length) throw new Error('config.venues has a duplicate code');

  return {
    region: requiredString(c.region, 'region'),
    venues,
    dates: [...new Set(venues.flatMap((v) => v.dates))].sort(),
    movies: topMovies,
    priorityFormats: strings(c.priorityFormats, 'priorityFormats'),
    poll,
    seats: parseSeats(c.seats),
  };
}

export function loadConfig(path = process.env.CONFIG_PATH ?? 'config.json'): WatchConfig {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`cannot read config at ${full}`);
  }
  return parseConfig(JSON.parse(text));
}

export interface EnvConfig {
  baseUrl: string;
  telegramToken: string;
  telegramChatId: string;
  redisUrl: string;
  userDataDir: string;
  headless: boolean;
  browserChannel?: string;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`missing env var ${k} (see .env.example)`);
    return v;
  };
  return {
    baseUrl: need('SITE_BASE_URL').replace(/\/+$/, ''),
    telegramToken: need('TELEGRAM_BOT_TOKEN'),
    telegramChatId: need('TELEGRAM_CHAT_ID'),
    redisUrl: env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
    userDataDir: resolve(env.BROWSER_PROFILE_DIR?.trim() || '.browser-profile'),
    headless: (env.HEADLESS ?? 'false').toLowerCase() === 'true',
    browserChannel: env.BROWSER_CHANNEL?.trim() || undefined,
  };
}
