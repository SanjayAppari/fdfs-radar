/**
 * The site's by-movie showtimes API (what its "buy tickets" page calls): one
 * request returns every cinema in the region showing a movie on a date, for
 * all formats of one language (etCodes=*). It has no screen names, event codes
 * per show or seat-class codes, so the watcher uses it only to notice changes
 * and then reads the venue's full showtimes. Pure; tested against fixtures/.
 *
 * Shape (only what is used):
 *   data.additionalData.dateCode   the date actually served; a date that isn't
 *                                  open returns the nearest open one instead
 *   …venue-card { additionalData.venueCode, showtimesSections[].showtimes[] }
 *   …showtime   { additionalData: { sessionId, availStatus, showDateTime, … } }
 *   …option     { additionalData: { eventCode ("*" = all formats), language, refEventCode } }
 *   metadata.error                 present when the request was not served
 */

export const BY_MOVIE_PATH = '/api/movies-data/v5/showtimes-by-event/primary-dynamic';

/** Request headers the endpoint needs (without them it answers 400 for everything). */
export const byMovieHeaders = (region: string): Record<string, string> => ({
  accept: 'application/json, text/plain, */*',
  'x-region-code': region,
  'x-app-code': 'WEB',
});

export interface ByMovieQuery {
  /** "*" for all formats of `language`, or one event code */
  etCodes: string;
  /** Required with "*": the language's reference event code */
  refEventCode?: string;
  /** Required with "*" (e.g. "English"); "" with a single event code */
  language?: string;
  date: string;
  region: string;
}

export function byMovieQueryString(q: ByMovieQuery): string {
  return new URLSearchParams({
    etCodes: q.etCodes,
    refEventCode: q.etCodes === '*' ? (q.refEventCode ?? '') : '',
    dateCode: q.date,
    isDesktop: 'true',
    regionCode: q.region,
    xLocationShared: 'false',
    memberId: '',
    lsId: '',
    subCode: '',
    appCode: 'WEB',
    language: q.language ?? '',
  }).toString();
}

export interface ByMovieShow {
  sessionId: string;
  availStatus: string;
  /** YYYYMMDD the show belongs to (a 00:35 show still belongs to the evening before) */
  showDateCode: string;
  /** YYYYMMDDHHmm */
  showDateTime: string;
  showTime: string;
  attributes: string;
}

export interface ByMovieResult {
  requestedDate: string;
  /** Date the site actually served */
  servedDate: string;
  /** servedDate === requestedDate: the date is open for this language somewhere in the region */
  open: boolean;
  /** Shows per venue code (only when open) */
  venues: Map<string, ByMovieShow[]>;
  /** Every format of the movie the site lists, with its language */
  formats: { eventCode: string; language: string }[];
  /** "All formats" entry per language: what to send as etCodes=* */
  languages: { language: string; refEventCode: string }[];
  /** Dates the site offers for this movie in the region (its date strip) */
  regionDates: string[];
}

/** The by-movie API didn't give a usable answer (error payload, unknown shape). Not a block. */
export class ByMovieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByMovieError';
  }
}

type Json = Record<string, any>;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

export function parseByMovie(json: unknown, requestedDate: string): ByMovieResult {
  const root = json as Json | null;
  if (!root || typeof root !== 'object') throw new ByMovieError('by-movie response is not an object');
  const err = root.metadata?.error;
  if (err) throw new ByMovieError(`by-movie request not served: ${str(err.title) || 'error'} (${str(err.errorCode) || 'no code'})`);
  const servedDate = str(root.data?.additionalData?.dateCode);
  if (!/^\d{8}$/.test(servedDate)) throw new ByMovieError('by-movie response has no date');
  const open = servedDate === requestedDate;

  const venues = new Map<string, ByMovieShow[]>();
  const formats = new Map<string, string>();
  const languages = new Map<string, string>();
  const regionDates = new Set<string>();

  const walk = (o: unknown, venue: string | undefined): void => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, venue);
      return;
    }
    const node = o as Json;
    const a = node.additionalData as Json | undefined;
    const vc = str(node.venueCode ?? a?.venueCode);
    if (vc) venue = vc;
    if (a && typeof a === 'object') {
      if (a.sessionId !== undefined && venue) {
        if (!venues.has(venue)) venues.set(venue, []);
        venues.get(venue)!.push({
          sessionId: str(a.sessionId),
          availStatus: str(a.availStatus),
          showDateCode: str(a.showDateCode),
          showDateTime: str(a.showDateTime),
          showTime: str(a.showTime),
          attributes: str(a.attributes),
        });
      }
      if (typeof a.eventCode === 'string' && a.language !== undefined) {
        const code = str(a.eventCode);
        const language = str(a.language);
        if (code === '*') {
          if (language && str(a.refEventCode)) languages.set(language, str(a.refEventCode));
        } else if (code && language) {
          formats.set(code, language);
        }
      }
    }
    if (typeof node.dateCode === 'string' && /^\d{8}$/.test(node.dateCode)) regionDates.add(node.dateCode);
    for (const v of Object.values(node)) walk(v, venue);
  };
  walk(root.data, undefined);

  // Only shows on the served date count; a closed date serves a different one.
  for (const [v, list] of venues) {
    const sameDay = list.filter((s) => (s.showDateCode || s.showDateTime.slice(0, 8) || servedDate) === servedDate);
    if (sameDay.length) venues.set(v, sameDay);
    else venues.delete(v);
  }

  return {
    requestedDate,
    servedDate,
    open,
    venues: open ? venues : new Map(),
    formats: [...formats].map(([eventCode, language]) => ({ eventCode, language })),
    languages: [...languages].map(([language, refEventCode]) => ({ language, refEventCode })),
    regionDates: [...regionDates].sort(),
  };
}
