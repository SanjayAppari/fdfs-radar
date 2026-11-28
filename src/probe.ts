/**
 * Change detection from the by-movie API. One by-movie response covers every
 * cinema for one movie, language and date; compared with the watcher's latest
 * per-venue snapshots it says which venue × date needs a full (per-venue)
 * refresh. That refresh then raises alerts exactly as before. Pure; tested.
 */
import type { ByMovieResult } from './sources/by-movie.js';
import type { DateSnapshot } from './sources/types.js';

export interface RefreshNeed {
  venue: string;
  reason: string;
}

const bookable = (availStatus: string) => availStatus !== '0' && availStatus !== '';

/**
 * Venues whose snapshot disagrees with the by-movie result:
 * - a show the snapshot doesn't have (new show, or the date opened),
 * - a show whose bookable state changed (sold out ↔ available),
 * - a show of this language the snapshot has but the site no longer lists.
 * Shows whose language isn't known are never reported "gone" (can't tell).
 */
export function venuesToRefresh(args: {
  result: ByMovieResult;
  language: string;
  /** The movie title as the per-venue data spells it (EventTitle) */
  movieTitle: string;
  /** Watched venues that have this date */
  venues: string[];
  snapshots: Map<string, DateSnapshot | undefined>;
  /** event code → language, from the by-movie format list */
  codeLanguage: Map<string, string>;
}): RefreshNeed[] {
  const { result, language, movieTitle, venues, snapshots, codeLanguage } = args;
  const out: RefreshNeed[] = [];
  for (const venue of venues) {
    const snap = snapshots.get(venue);
    if (snap?.status === 'venue_down') continue;
    const site = new Map((result.open ? (result.venues.get(venue) ?? []) : []).map((s) => [s.sessionId, bookable(s.availStatus)]));
    const mine = (snap?.status === 'open' ? snap.shows : []).filter((s) => s.movie === movieTitle);
    const mineById = new Map(mine.map((s) => [s.sessionId, s]));

    let reason: string | undefined;
    for (const [sid, siteBookable] of site) {
      const m = mineById.get(sid);
      if (!m) {
        reason = snap?.status === 'open' ? `new show ${sid}` : `shows listed (date was ${snap?.status ?? 'never polled'})`;
        break;
      }
      if (bookable(m.availStatus) !== siteBookable) {
        reason = `show ${sid} ${siteBookable ? 'became available' : 'no longer available'}`;
        break;
      }
    }
    if (!reason) {
      const gone = mine.find((s) => codeLanguage.get(s.eventCode) === language && !site.has(s.sessionId));
      if (gone) reason = `show ${gone.sessionId} no longer listed`;
    }
    if (reason) out.push({ venue, reason });
  }
  return out;
}
