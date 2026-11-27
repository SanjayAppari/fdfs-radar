import type { WatchConfig } from './config.js';
import type { DateSnapshot, Show } from './sources/types.js';
import type { KV, KVWrite } from './store.js';

/** What we persist per date + SessionId. */
export interface ShowRecord {
  movie: string;
  eventName: string;
  dimension: string;
  screen: string;
  attributes: string;
  time: string;
  availStatus: string;
}

export interface AlertShow {
  show: Show;
  priority: boolean;
  /** New show is on a screen this movie had no other show on (that date) */
  newScreen?: boolean;
  /** New show is in a format this movie had no other show in (that date) */
  newFormat?: boolean;
}

export type Alert =
  | { kind: 'date_open'; date: string; shows: AlertShow[] }
  | { kind: 'new_show'; date: string; item: AlertShow }
  | { kind: 'avail_up'; date: string; item: AlertShow };

export interface DiffResult {
  /** True when this date was seen for the first time (state recorded, no alerts). */
  baseline: boolean;
  alerts: Alert[];
  /** Keys commit() will write (for the live dashboard). */
  touchedKeys: string[];
  /**
   * Persist the new state + dedupe markers. Call ONLY after the alerts were
   * delivered, so a failed Telegram send is retried on the next poll.
   */
  commit(): Promise<void>;
}

const DAY = 86_400;
const STATE_TTL = 90 * DAY;
const DEDUPE_TTL = 90 * DAY;
/** Seats can go 0→1→0→1 when holds expire; allow a repeat alert after this. */
const AVAIL_DEDUPE_TTL = 30 * 60;

export const keys = (source: string, venue: string) => {
  const p = `fdfs:${source}:${venue}`;
  return {
    baseline: (date: string) => `${p}:baseline:${date}`,
    open: (date: string) => `${p}:open:${date}`,
    show: (date: string, sid: string) => `${p}:show:${date}:${sid}`,
    alerted: (kind: string, date: string, sid = '-') => `${p}:alerted:${kind}:${date}:${sid}`,
  };
};

const includesAny = (haystack: string, needles: string[]) => {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
};

export const isWatchedMovie = (show: Show, cfg: Pick<WatchConfig, 'movies'>) =>
  cfg.movies.length === 0 || includesAny(show.movie, cfg.movies);

export const isPriority = (show: Show, cfg: Pick<WatchConfig, 'priorityFormats'>) =>
  cfg.priorityFormats.length > 0 && includesAny(`${show.attributes} ${show.dimension}`, cfg.priorityFormats);

const toRecord = (s: Show): ShowRecord => ({
  movie: s.movie,
  eventName: s.eventName,
  dimension: s.dimension,
  screen: s.screen,
  attributes: s.attributes,
  time: s.time,
  availStatus: s.availStatus,
});

function parseRecord(raw: string | null): ShowRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShowRecord;
  } catch {
    return null;
  }
}

export async function diffSnapshot(
  store: KV,
  snap: DateSnapshot,
  cfg: Pick<WatchConfig, 'movies' | 'priorityFormats'>,
): Promise<DiffResult> {
  const k = keys(snap.source, snap.venue);
  const { date } = snap;

  // Venue reported down: no information either way, touch nothing.
  if (snap.status === 'venue_down') {
    return { baseline: false, alerts: [], touchedKeys: [], commit: async () => {} };
  }

  const [baselineRaw, openRaw] = await store.mget([k.baseline(date), k.open(date)]);
  const isBaseline = !baselineRaw;
  const wasOpen = openRaw === '1';
  const isOpen = snap.status === 'open';

  const writes: KVWrite[] = [{ key: k.open(date), value: isOpen ? '1' : '0', ttlSeconds: STATE_TTL }];
  const dedupeKeys: { key: string; ttl: number }[] = [];
  const alerts: Alert[] = [];

  if (isBaseline) writes.push({ key: k.baseline(date), value: new Date().toISOString(), ttlSeconds: STATE_TTL });

  if (!isOpen) {
    return { baseline: isBaseline, alerts, touchedKeys: writes.map((w) => w.key), commit: () => store.writeAll(writes) };
  }

  const watched = (s: Show) => isWatchedMovie(s, cfg);
  const wrap = (s: Show): AlertShow => ({ show: s, priority: isPriority(s, cfg) });

  // Previous records + dedupe flags in one round trip.
  const dateOpenKey = k.alerted('date_open', date);
  const sessionKeys = snap.shows.map((s) => k.show(date, s.sessionId));
  const newKeys = snap.shows.map((s) => k.alerted('new', date, s.sessionId));
  const availKeys = snap.shows.map((s) => k.alerted('avail', date, s.sessionId));
  const fetched = await store.mget([dateOpenKey, ...sessionKeys, ...newKeys, ...availKeys]);
  const n = snap.shows.length;
  const dateOpenAlerted = fetched[0] !== null;
  const prevRecords = fetched.slice(1, 1 + n).map(parseRecord);
  const newAlerted = fetched.slice(1 + n, 1 + 2 * n);
  const availAlerted = fetched.slice(1 + 2 * n, 1 + 3 * n);

  // A date that just opened gets ONE summary alert instead of one per show.
  let summarised = false;
  if (!isBaseline && !wasOpen && !dateOpenAlerted) {
    alerts.push({ kind: 'date_open', date, shows: snap.shows.filter(watched).map(wrap) });
    dedupeKeys.push({ key: dateOpenKey, ttl: DEDUPE_TTL });
    summarised = true;
  }

  // What each movie already had (shows seen before) — to flag new screens/formats.
  const known = new Map<string, { screens: Set<string>; formats: Set<string> }>();
  snap.shows.forEach((s, i) => {
    if (!prevRecords[i]) return;
    const k = known.get(s.movie) ?? { screens: new Set(), formats: new Set() };
    k.screens.add(s.screen);
    k.formats.add(`${s.dimension}|${s.attributes}`);
    known.set(s.movie, k);
  });

  snap.shows.forEach((show, i) => {
    writes.push({ key: sessionKeys[i]!, value: JSON.stringify(toRecord(show)), ttlSeconds: STATE_TTL });
    if (isBaseline || summarised || !watched(show)) return;

    const prev = prevRecords[i];
    if (!prev) {
      if (newAlerted[i] === null) {
        const k = known.get(show.movie);
        alerts.push({
          kind: 'new_show',
          date,
          item: {
            ...wrap(show),
            newScreen: !k?.screens.has(show.screen),
            newFormat: !k?.formats.has(`${show.dimension}|${show.attributes}`),
          },
        });
        dedupeKeys.push({ key: newKeys[i]!, ttl: DEDUPE_TTL });
      }
    } else if (prev.availStatus !== '1' && show.availStatus === '1') {
      if (availAlerted[i] === null) {
        alerts.push({ kind: 'avail_up', date, item: wrap(show) });
        dedupeKeys.push({ key: availKeys[i]!, ttl: AVAIL_DEDUPE_TTL });
      }
    }
  });

  return {
    baseline: isBaseline,
    alerts,
    touchedKeys: [...writes.map((w) => w.key), ...dedupeKeys.map((d) => d.key)],
    commit: async () => {
      for (const d of dedupeKeys) await store.setNX(d.key, '1', d.ttl);
      await store.writeAll(writes);
    },
  };
}
