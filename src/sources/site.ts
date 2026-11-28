/**
 * Site-specific pieces shared by every way of reaching the ticketing site
 * (browser or plain HTTP): the showtimes parser, response classification
 * and URL builders. Pure; unit-tested against fixtures/.
 */
import { BlockedError, type DateSnapshot, type Show, type VenueRef } from './types.js';

type Json = Record<string, any>;

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Accepts either the full byvenue response ({ ShowDatesArray, ShowDetails[] })
 * or a bare ShowDetails[0] object (what the fixture contains).
 */
export function parseByVenue(
  json: unknown,
  date: string,
  meta: { source: string; venue: string },
): DateSnapshot {
  const base = { source: meta.source, venue: meta.venue, date };
  if (!json || typeof json !== 'object') {
    return { ...base, status: 'not_open', openDates: null, shows: [] };
  }

  const root = json as Json;

  const openDates: string[] | null = Array.isArray(root.ShowDatesArray)
    ? root.ShowDatesArray.filter((d: Json) => !isTruthyFlag(d?.isDisabled)).map((d: Json) => str(d?.DateCode))
    : null;

  const details: Json | undefined = Array.isArray(root.ShowDetails)
    ? root.ShowDetails[0]
    : root.Event
      ? root
      : undefined;

  if (!details || str(details.Date) !== date) {
    return { ...base, status: 'not_open', openDates, shows: [] };
  }
  if (openDates && !openDates.includes(date)) {
    return { ...base, status: 'not_open', openDates, shows: [] };
  }
  if (isTruthyFlag(details.Venues?.isVenueDown)) {
    return { ...base, status: 'venue_down', openDates, shows: [] };
  }

  const shows: Show[] = [];
  for (const ev of asArray(details.Event)) {
    const movie = str(ev.EventTitle);
    for (const child of asArray(ev.ChildEvents)) {
      for (const st of asArray(child.ShowTimes)) {
        const sessionId = str(st.SessionId);
        if (!sessionId) continue;
        shows.push({
          ...base,
          sessionId,
          movie,
          eventName: str(child.EventName),
          eventCode: str(child.EventCode),
          dimension: str(child.EventDimension),
          screen: str(st.ScreenName),
          attributes: str(st.Attributes),
          time: str(st.ShowTime),
          showDateTime: str(st.ShowDateTime),
          availStatus: str(st.AvailStatus),
          categories: asArray(st.Categories).map((c) => ({
            name: str(c.PriceDesc),
            price: str(c.CurPrice),
            availStatus: str(c.AvailStatus),
            ...(str(c.AreaCatCode) ? { code: str(c.AreaCatCode) } : {}),
          })),
        });
      }
    }
  }
  return { ...base, status: 'open', openDates, shows };
}

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || str(v).toLowerCase() === 'true' || str(v).toUpperCase() === 'Y';
}

// ---------------------------------------------------------------------------
// Showtimes response → snapshot (or a typed error)
// ---------------------------------------------------------------------------

/** What a showtimes request came back with, however it was sent. */
export interface ShowtimesResponse {
  status: number;
  contentType: string;
  retryAfter: string;
  text: string;
}

/**
 * Non-JSON (bot check page) → BlockedError; 429 → BlockedError with
 * Retry-After; other HTTP errors → BlockedError; otherwise the parsed snapshot.
 */
export function snapshotFromResponse(
  res: ShowtimesResponse,
  date: string,
  meta: { source: string; venue: string },
): DateSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new BlockedError(
      `non-JSON response (HTTP ${res.status}, ${res.contentType || 'no content-type'}): ${res.text.slice(0, 120).replace(/\s+/g, ' ')}`,
      res.status,
    );
  }
  if (res.status >= 400) {
    const ra = Number.parseInt(res.retryAfter, 10);
    throw new BlockedError(
      res.status === 429 ? 'rate limited (HTTP 429)' : `HTTP ${res.status} with JSON body`,
      res.status,
      Number.isFinite(ra) ? ra : undefined,
    );
  }
  return parseByVenue(json, date, meta);
}

export interface RateHint {
  remaining?: number;
  limit?: number;
  resetSeconds?: number;
  retryAfter?: number;
}

/** Rate-limit headers, when the site sends them. */
export function rateHintFrom(get: (header: string) => string | null | undefined): RateHint {
  const num = (v: string | null | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    remaining: num(get('x-ratelimit-remaining') ?? get('ratelimit-remaining')),
    limit: num(get('x-ratelimit-limit') ?? get('ratelimit-limit')),
    resetSeconds: num(get('x-ratelimit-reset') ?? get('ratelimit-reset')),
    retryAfter: num(get('retry-after')),
  };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function showtimesPath(venue: string, date: string, region: string, live: boolean): string {
  // The response is otherwise served from the CDN cache, often minutes old;
  // a unique parameter makes every poll return live data.
  return (
    `/api/v3/mobile/showtimes/byvenue?dateCode=${date}` +
    `&venueCode=${encodeURIComponent(venue)}&regionCode=${encodeURIComponent(region)}&appCode=WEBV2` +
    (live ? `&_=${Date.now()}${Math.floor(Math.random() * 1000)}` : '')
  );
}

export function bookingUrl(baseUrl: string, region: string, venue: VenueRef, date: string): string {
  return `${baseUrl}/cinemas/${region}/${venue.slug}/buytickets/${venue.code}/${date}`;
}

export function seatMapUrl(
  baseUrl: string,
  region: string,
  show: { eventCode: string; venue: string; sessionId: string; date: string },
): string {
  return `${baseUrl}/movies/${region}/seat-layout/${show.eventCode}/${show.venue}/${show.sessionId}/${show.date}`;
}
