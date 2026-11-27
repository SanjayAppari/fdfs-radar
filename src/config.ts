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
}

export interface SeatConfig {
  enabled: boolean;
  /** Max seat maps to read per polling round */
  perRound: number;
  /** Re-read a show's seat map at most this often */
  minIntervalMinutes: number;
  middle: MiddlePolicy;
  /** Per-screen layout hints, keyed by screen name as shown, e.g. "SCREEN 6" */
  screens: Record<string, ScreenOverride>;
}

export interface WatchConfig {
  /** Display name used in alerts */
  venueName: string;
  venue: string;
  venueSlug: string;
  region: string;
  /** YYYYMMDD */
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
  perRound: 3,
  minIntervalMinutes: 5,
  middle: { rowsFrom: 0.3, rowsTo: 0.85, centerWidth: 0.6, seatsTogether: 1 },
  screens: {},
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
  const screens: Record<string, ScreenOverride> = {};
  for (const [name, o] of Object.entries(r.screens ?? {})) screens[name.trim().toUpperCase()] = o;
  return {
    enabled: r.enabled ?? DEFAULT_SEATS.enabled,
    perRound: r.perRound ?? DEFAULT_SEATS.perRound,
    minIntervalMinutes: r.minIntervalMinutes ?? DEFAULT_SEATS.minIntervalMinutes,
    middle,
    screens,
  };
}

const DEFAULT_POLL: PollConfig = {
  minSeconds: 60,
  maxSeconds: 90,
  gapMinSeconds: 2,
  gapMaxSeconds: 5,
  blockedBackoffMinMinutes: 5,
  blockedBackoffMaxMinutes: 10,
  reloadEveryMinutes: 45,
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

export function parseConfig(raw: unknown): WatchConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const c = raw as Record<string, unknown>;
  const dates = [...new Set(strings(c.dates, 'dates').map(normaliseDate))].sort();
  if (dates.length === 0) throw new Error('config.dates must list at least one date');

  const poll = { ...DEFAULT_POLL, ...((c.poll as Partial<PollConfig>) ?? {}) };
  if (poll.minSeconds > poll.maxSeconds) throw new Error('poll.minSeconds must be <= poll.maxSeconds');

  return {
    venueName: typeof c.venueName === 'string' && c.venueName.trim() ? c.venueName.trim() : requiredString(c.venue, 'venue'),
    venue: requiredString(c.venue, 'venue'),
    venueSlug: requiredString(c.venueSlug, 'venueSlug'),
    region: requiredString(c.region, 'region'),
    dates,
    movies: strings(c.movies, 'movies'),
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
