/**
 * Live view state for the dashboard. Written by the watcher, read by
 * src/web/server.ts. Purely informational: alerting never reads these keys.
 */
import type { VenueConfig, WatchConfig } from './config.js';
import { isPriority, isWatchedMovie, type Alert } from './diff.js';
import { log } from './log.js';
import type { SeatSummary } from './seats.js';
import type { DateSnapshot, Show } from './sources/types.js';
import type { RedisStore } from './store.js';

export const LIVE_CHANNEL = 'fdfs:events';
export const STATUS_KEY = 'fdfs:status';
export const ALERT_LOG_KEY = 'fdfs:alerts:log';
export const snapshotKey = (source: string, venue: string, date: string) => `fdfs:${source}:${venue}:snapshot:${date}`;
export const seatsKey = (source: string, venue: string, date: string, sessionId: string) =>
  `fdfs:${source}:${venue}:seats:${date}:${sessionId}`;
export const layoutKey = (source: string, venue: string, screen: string) =>
  `fdfs:${source}:${venue}:layout:${screen.trim().toUpperCase().replace(/\s+/g, '_')}`;

export interface SeatResult extends SeatSummary {
  source: string;
  venue: string;
  date: string;
  sessionId: string;
  screen: string;
}

export interface LiveShow extends Show {
  watched: boolean;
  priority: boolean;
}

export interface LiveSnapshot {
  source: string;
  venue: string;
  venueName: string;
  date: string;
  status: DateSnapshot['status'];
  openDates: string[] | null;
  fetchedAt: string;
  bookingUrl: string;
  shows: LiveShow[];
}

export interface WatcherStatus {
  state: 'starting' | 'ok' | 'blocked' | 'error' | 'stopped';
  message?: string;
  since: string;
  startedAt: string;
  lastPollAt?: string;
  venues: { code: string; name: string; dates: string[]; movies: string[] }[];
  /** Shows the fast loop is re-reading, as source:venue:date:sessionId */
  hot?: string[];
  source: string;
  dates: string[];
  movies: string[];
  priorityFormats: string[];
  pollSeconds: [number, number];
}

export type LiveEvent =
  | { type: 'snapshot'; date: string; venue: string; source: string; keys: string[] }
  | { type: 'seats'; date: string; sessionId: string; keys: string[] }
  | { type: 'status'; status: WatcherStatus }
  | { type: 'alert'; entry: AlertLogEntry };

export interface AlertLogEntry {
  at: string;
  date: string;
  venue?: string;
  venueName?: string;
  kind: Alert['kind'] | 'middle_seats';
  priority: boolean;
  summary: string;
}

const SNAPSHOT_TTL = 90 * 86_400;

export class LiveFeed {
  private status: WatcherStatus;

  constructor(
    private readonly store: RedisStore,
    private readonly cfg: WatchConfig,
    source: string,
  ) {
    const now = new Date().toISOString();
    this.status = {
      state: 'starting',
      since: now,
      startedAt: now,
      venues: cfg.venues.map((v) => ({ code: v.code, name: v.name, dates: v.dates, movies: v.movies })),
      source,
      dates: cfg.dates,
      movies: cfg.movies,
      priorityFormats: cfg.priorityFormats,
      pollSeconds: [cfg.poll.minSeconds, cfg.poll.maxSeconds],
    };
  }

  private async emit(event: LiveEvent) {
    await this.store.publish(LIVE_CHANNEL, JSON.stringify(event));
  }

  /** Never let the dashboard feed break polling. */
  private async safe(what: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      log.warn(`live feed (${what}) failed: ${(err as Error).message}`);
    }
  }

  setStatus(state: WatcherStatus['state'], message?: string) {
    return this.safe('status', async () => {
      const now = new Date().toISOString();
      if (state !== this.status.state) this.status.since = now;
      this.status = { ...this.status, state, message };
      if (state === 'ok') this.status.lastPollAt = now;
      await this.store.writeAll([{ key: STATUS_KEY, value: JSON.stringify(this.status) }]);
      await this.emit({ type: 'status', status: this.status });
    });
  }

  setHot(keys: string[]) {
    return this.safe('hot', async () => {
      this.status = { ...this.status, hot: keys };
      await this.store.writeAll([{ key: STATUS_KEY, value: JSON.stringify(this.status) }]);
      await this.emit({ type: 'status', status: this.status });
    });
  }

    snapshot(venue: VenueConfig, snap: DateSnapshot, bookingUrl: string, changedKeys: string[]) {
    return this.safe('snapshot', async () => {
      const key = snapshotKey(snap.source, snap.venue, snap.date);
      const live: LiveSnapshot = {
        source: snap.source,
        venue: snap.venue,
        venueName: venue.name,
        date: snap.date,
        status: snap.status,
        openDates: snap.openDates,
        fetchedAt: new Date().toISOString(),
        bookingUrl,
        shows: snap.shows.map((s) => ({ ...s, watched: isWatchedMovie(s, venue), priority: isPriority(s, this.cfg) })),
      };
      await this.store.writeAll([{ key, value: JSON.stringify(live), ttlSeconds: SNAPSHOT_TTL }]);
      await this.emit({ type: 'snapshot', date: snap.date, venue: snap.venue, source: snap.source, keys: [key, ...changedKeys] });
    });
  }

  seats(result: SeatResult, extraKeys: string[] = []) {
    return this.safe('seats', async () => {
      const key = seatsKey(result.source, result.venue, result.date, result.sessionId);
      await this.store.writeAll([{ key, value: JSON.stringify(result), ttlSeconds: 14 * 86_400 }]);
      await this.emit({ type: 'seats', date: result.date, sessionId: result.sessionId, keys: [key, ...extraKeys] });
    });
  }

  /** Record an alert that didn't come from the diff (e.g. middle seats). */
  logAlert(entry: Omit<AlertLogEntry, 'at'>) {
    return this.safe('alert log', async () => {
      const full: AlertLogEntry = { at: new Date().toISOString(), ...entry };
      await this.store.pushCapped(ALERT_LOG_KEY, JSON.stringify(full), 200);
      await this.emit({ type: 'alert', entry: full });
    });
  }

  alerts(venue: VenueConfig, alerts: Alert[]) {
    return this.safe('alerts', async () => {
      for (const a of alerts) {
        const entry = { ...toLogEntry(a), venue: venue.code, venueName: venue.name };
        await this.store.pushCapped(ALERT_LOG_KEY, JSON.stringify(entry), 200);
        await this.emit({ type: 'alert', entry });
      }
    });
  }
}

function toLogEntry(a: Alert): AlertLogEntry {
  const at = new Date().toISOString();
  if (a.kind === 'date_open') {
    return {
      at,
      date: a.date,
      kind: a.kind,
      priority: a.shows.some((s) => s.priority),
      summary: `Bookings opened — ${a.shows.length} watched show(s)`,
    };
  }
  const s = a.item.show;
  const verb = a.kind === 'new_show' ? 'New show' : 'Seats available';
  return {
    at,
    date: a.date,
    kind: a.kind,
    priority: a.item.priority,
    summary: `${verb}: ${s.movie} · ${s.dimension} · ${s.time} · ${[s.screen, s.attributes].filter(Boolean).join(' · ')}`,
  };
}
