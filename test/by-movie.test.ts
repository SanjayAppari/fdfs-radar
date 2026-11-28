import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { venuesToRefresh } from '../src/probe.js';
import { ByMovieError, byMovieQueryString, parseByMovie, type ByMovieResult } from '../src/sources/by-movie.js';
import type { DateSnapshot, Show } from '../src/sources/types.js';

/** Real responses captured on 28 Nov: Telugu all-formats 17 Dec, English all-formats 21 Dec. */
const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)), 'utf8'));

describe('parseByMovie', () => {
  it('reads every cinema, its shows, the formats and the languages', () => {
    const r = parseByMovie(fixture('by-movie-telugu-20261217'), '20261217');
    expect(r.open).toBe(true);
    expect(r.servedDate).toBe('20261217');
    expect(r.venues.size).toBeGreaterThan(5);
    expect(r.venues.get('ALUC')!.map((s) => s.sessionId)).toContain('7010'); // ALLU's Telugu show
    const s = r.venues.get('ALUC')!.find((x) => x.sessionId === '7010')!;
    expect(s.showDateCode).toBe('20261217');
    expect(s.availStatus).toMatch(/^[0-3]$/);
    expect(r.languages).toEqual(
      expect.arrayContaining([
        { language: 'English', refEventCode: 'ET00439706' },
        { language: 'Telugu', refEventCode: 'ET00526371' },
      ]),
    );
    expect(r.formats).toEqual(expect.arrayContaining([{ eventCode: 'ET00526306', language: 'English' }, { eventCode: 'ET00526371', language: 'Telugu' }]));
    expect(r.regionDates).toEqual(['20261217', '20261218', '20261219', '20261220']); // Telugu isn't open on the 21st
  });

  it('a partly open date lists only the cinemas that are open', () => {
    const r = parseByMovie(fixture('by-movie-english-20261221'), '20261221');
    expect(r.open).toBe(true);
    expect([...r.venues.keys()].sort()).toEqual(['ALUC', 'PRHN']);
    expect(r.regionDates).toContain('20261221');
  });

  it('a date that is not open serves another date: no venues, open=false', () => {
    // What the site does for 25 Dec: it serves the nearest open date instead.
    const r = parseByMovie(fixture('by-movie-telugu-20261217'), '20261225');
    expect(r.open).toBe(false);
    expect(r.servedDate).toBe('20261217');
    expect(r.venues.size).toBe(0);
    expect(r.languages.length).toBeGreaterThan(0); // options still usable
  });

  it('an error payload is a ByMovieError (not a block)', () => {
    const err = { data: { additionalData: {} }, metadata: { error: { title: 'Oops, Something went wrong', errorCode: '1a.1m.1005' } } };
    expect(() => parseByMovie(err, '20261217')).toThrow(ByMovieError);
    expect(() => parseByMovie({ data: {} }, '20261217')).toThrow(ByMovieError);
  });

  it('builds the query the site expects', () => {
    const q = new URLSearchParams(byMovieQueryString({ etCodes: '*', refEventCode: 'ET1', language: 'English', date: '20261217', region: 'HYD' }));
    expect(Object.fromEntries(q)).toMatchObject({ etCodes: '*', refEventCode: 'ET1', language: 'English', dateCode: '20261217', regionCode: 'HYD', appCode: 'WEB' });
    // A single event code carries no refEventCode/language.
    const one = new URLSearchParams(byMovieQueryString({ etCodes: 'ET1', date: '20261217', region: 'HYD' }));
    expect(one.get('refEventCode')).toBe('');
    expect(one.get('language')).toBe('');
  });
});

// ---------------------------------------------------------------------------

const TITLE = 'Avengers: Doomsday';
const show = (sessionId: string, availStatus: string, eventCode = 'EN3D', movie = TITLE): Show =>
  ({ sessionId, availStatus, eventCode, movie }) as Show;
const snap = (status: DateSnapshot['status'], shows: Show[]): DateSnapshot =>
  ({ source: 'ticketing', venue: 'V', date: '20261217', status, openDates: null, shows }) as DateSnapshot;
const result = (venues: Record<string, [string, string][]>, open = true): ByMovieResult => ({
  requestedDate: '20261217',
  servedDate: open ? '20261217' : '20261218',
  open,
  venues: new Map(Object.entries(venues).map(([v, l]) => [v, l.map(([sessionId, availStatus]) => ({ sessionId, availStatus, showDateCode: '20261217', showDateTime: '', showTime: '', attributes: '' }))])),
  formats: [],
  languages: [],
  regionDates: [],
});
const LANG = new Map([
  ['EN3D', 'English'],
  ['TE2D', 'Telugu'],
]);
const run = (r: ByMovieResult, snaps: Record<string, DateSnapshot | undefined>, language = 'English') =>
  venuesToRefresh({ result: r, language, movieTitle: TITLE, venues: Object.keys(snaps), snapshots: new Map(Object.entries(snaps)), codeLanguage: LANG });

describe('venuesToRefresh', () => {
  it('nothing to do when the site matches the snapshot', () => {
    expect(run(result({ A: [['1', '1'], ['2', '0']] }), { A: snap('open', [show('1', '3'), show('2', '0')]) })).toEqual([]);
  });

  it('ignores availability nuances (3 → 2 "filling fast"), only bookable vs not', () => {
    expect(run(result({ A: [['1', '2']] }), { A: snap('open', [show('1', '3')]) })).toEqual([]);
  });

  it('a new show at one venue refreshes only that venue', () => {
    const need = run(result({ A: [['1', '1']], B: [['5', '1'], ['6', '1']] }), { A: snap('open', [show('1', '1')]), B: snap('open', [show('5', '1')]) });
    expect(need).toEqual([{ venue: 'B', reason: 'new show 6' }]);
  });

  it('sold out → available, and available → sold out', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('open', [show('1', '0')]) })).toEqual([{ venue: 'A', reason: 'show 1 became available' }]);
    expect(run(result({ A: [['1', '0']] }), { A: snap('open', [show('1', '1')]) })).toEqual([{ venue: 'A', reason: 'show 1 no longer available' }]);
  });

  it('a date opening at a venue (snapshot not_open, site lists shows)', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('not_open', []) })).toEqual([{ venue: 'A', reason: 'shows listed (date was not_open)' }]);
    expect(run(result({ A: [['1', '1']] }), { A: undefined })).toEqual([{ venue: 'A', reason: 'shows listed (date was never polled)' }]);
  });

  it('a show of this language that the site no longer lists', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('open', [show('1', '1'), show('2', '1')]) })).toEqual([{ venue: 'A', reason: 'show 2 no longer listed' }]);
  });

  it("other languages' shows are not reported gone by this language's result", () => {
    // Telugu show 9 isn't in the English result: fine.
    expect(run(result({ A: [['1', '1']] }), { A: snap('open', [show('1', '1'), show('9', '1', 'TE2D')]) })).toEqual([]);
  });

  it('shows with an unknown format code are never reported gone', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('open', [show('1', '1'), show('7', '1', 'UNKNOWN')]) })).toEqual([]);
  });

  it('other movies at the venue are ignored', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('open', [show('1', '1'), show('50', '1', 'X', 'Some Other Film')]) })).toEqual([]);
  });

  it('date closed on the site (served another date): snapshot shows of this language are gone', () => {
    expect(run(result({}, false), { A: snap('open', [show('1', '1')]) })).toEqual([{ venue: 'A', reason: 'show 1 no longer listed' }]);
    expect(run(result({}, false), { A: snap('not_open', []) })).toEqual([]);
  });

  it('skips a venue that is down', () => {
    expect(run(result({ A: [['1', '1']] }), { A: snap('venue_down', []) })).toEqual([]);
  });
});
