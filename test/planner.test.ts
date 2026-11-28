import { describe, expect, it } from 'vitest';
import { ByMoviePlanner, type Combo, type PlannerAction } from '../src/planner.js';
import type { ByMovieResult } from '../src/sources/by-movie.js';
import type { DateSnapshot, Show } from '../src/sources/types.js';

const MIN = 60_000;
const TITLE = 'Avengers: Doomsday';

function setup(over: { priorityShare?: number; fullRefreshMs?: number } = {}) {
  let t = 10_000_000;
  const p = new ByMoviePlanner({ fullRefreshMs: over.fullRefreshMs ?? 60 * MIN, priorityShare: over.priorityShare ?? 0.75, now: () => t });
  return { p, advance: (ms: number) => (t += ms), now: () => t };
}

const combos = (dates: string[], venues: string[], priorityDates: string[] = []): Combo[] =>
  dates.flatMap((date) => venues.map((venue) => ({ venue, date, priority: priorityDates.includes(date) })));

const languagesResult = (dates: Record<string, string[]>): ByMovieResult => ({
  requestedDate: '20261217',
  servedDate: '20261217',
  open: true,
  venues: new Map(),
  formats: [
    { eventCode: 'EN3D', language: 'English' },
    { eventCode: 'TE2D', language: 'Telugu' },
  ],
  languages: Object.keys(dates).map((language) => ({ language, refEventCode: `REF-${language}` })),
  regionDates: [],
});

const result = (date: string, venues: Record<string, [string, string][]>, regionDates: string[]): ByMovieResult => ({
  requestedDate: date,
  servedDate: date,
  open: true,
  venues: new Map(Object.entries(venues).map(([v, l]) => [v, l.map(([sessionId, availStatus]) => ({ sessionId, availStatus, showDateCode: date, showDateTime: '', showTime: '', attributes: '' }))])),
  formats: [{ eventCode: 'EN3D', language: 'English' }],
  languages: [{ language: 'English', refEventCode: 'REF-English' }],
  regionDates,
});

const snap = (date: string, shows: [string, string][]): DateSnapshot =>
  ({
    source: 'ticketing',
    venue: 'V',
    date,
    status: 'open',
    openDates: null,
    shows: shows.map(([sessionId, availStatus]) => ({ sessionId, availStatus, eventCode: 'EN3D', movie: TITLE }) as Show),
  }) as DateSnapshot;

/** Mark every combo as read just now, so the safety net stays quiet. */
const readAll = (p: ByMoviePlanner, cs: Combo[], at: number) => cs.forEach((c) => p.read(c.venue, c.date, at));

/** Learn the movie and answer its first (bootstrap) request with the given languages. */
function learned(p: ByMoviePlanner, cs: Combo[], now: number, languages: Record<string, string[]> = { English: [], Telugu: [] }) {
  p.learn([{ movie: TITLE, eventCode: 'EN3D', date: '20261217' }]);
  readAll(p, cs, now);
  const boot = p.next(cs) as PlannerAction & { kind: 'probe' };
  expect(boot).toMatchObject({ kind: 'probe', bootstrap: true, etCodes: 'EN3D', language: '' });
  p.onProbe(boot, languagesResult(languages), { venues: [], snapshots: new Map() });
}

describe('ByMoviePlanner', () => {
  it('does nothing until it has learned a movie (the caller keeps the plain rotation)', () => {
    const { p } = setup();
    expect(p.next(combos(['20261217'], ['A']))).toBeNull();
  });

  it('first asks once for the movie with a known event code, to learn its languages', () => {
    const { p, now } = setup();
    const cs = combos(['20261217', '20261218'], ['A', 'B']);
    learned(p, cs, now());
    const a = p.next(cs);
    expect(a).toMatchObject({ kind: 'probe', etCodes: '*', bootstrap: false });
    expect(['English', 'Telugu']).toContain((a as { language: string }).language);
  });

  it('cycles through every language × date, least recently asked first', () => {
    const { p, now, advance } = setup({ priorityShare: 0 });
    const cs = combos(['20261217', '20261218'], ['A']);
    learned(p, cs, now());
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      advance(1000);
      const a = p.next(cs) as { language: string; date: string };
      seen.add(`${a.language} ${a.date}`);
    }
    expect([...seen].sort()).toEqual(['English 20261217', 'English 20261218', 'Telugu 20261217', 'Telugu 20261218']);
  });

  it('gives priority dates their share of the by-movie requests', () => {
    const { p, now, advance } = setup({ priorityShare: 0.75 });
    const cs = combos(['20261217', '20261219', '20261220'], ['A'], ['20261217']);
    learned(p, cs, now());
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      advance(1000);
      const a = p.next(cs) as { date: string };
      counts[a.date] = (counts[a.date] ?? 0) + 1;
    }
    expect(counts['20261217']).toBe(30);
    expect((counts['20261219'] ?? 0) + (counts['20261220'] ?? 0)).toBe(10);
  });

  it("skips dates the site doesn't offer in a language (Telugu not open on the 21st)", () => {
    const { p, now, advance } = setup({ priorityShare: 0 });
    const cs = combos(['20261217', '20261221'], ['A']);
    learned(p, cs, now(), { Telugu: [] });
    const telugu17 = { kind: 'probe', movie: TITLE, etCodes: '*', refEventCode: 'REF-Telugu', language: 'Telugu', date: '20261217', bootstrap: false } as const;
    p.onProbe(telugu17, { ...result('20261217', {}, ['20261217', '20261218']), languages: [{ language: 'Telugu', refEventCode: 'REF-Telugu' }] }, { venues: ['A'], snapshots: new Map() });
    for (let i = 0; i < 5; i++) {
      advance(1000);
      expect(p.next(cs)).toMatchObject({ language: 'Telugu', date: '20261217' });
    }
    // The 21st shows up in Telugu's date list: it gets asked about too.
    p.onProbe(telugu17, { ...result('20261217', {}, ['20261217', '20261221']), languages: [{ language: 'Telugu', refEventCode: 'REF-Telugu' }] }, { venues: ['A'], snapshots: new Map() });
    const dates = new Set<string>();
    for (let i = 0; i < 4; i++) {
      advance(1000);
      dates.add((p.next(cs) as { date: string }).date);
    }
    expect([...dates].sort()).toEqual(['20261217', '20261221']);
  });

  it('a change found by a by-movie request becomes the very next request: read that venue × date in full', () => {
    const { p, now, advance } = setup();
    const cs = combos(['20261217'], ['A', 'B']);
    learned(p, cs, now(), { English: [] });
    advance(2 * MIN); // past the cooldown since the reads above
    const probe = p.next(cs) as PlannerAction & { kind: 'probe' };
    const needs = p.onProbe(probe, result('20261217', { A: [['1', '1']], B: [['5', '1'], ['6', '1']] }, ['20261217']), {
      venues: ['A', 'B'],
      snapshots: new Map([
        ['A', snap('20261217', [['1', '1']])],
        ['B', snap('20261217', [['5', '1']])],
      ]),
    });
    expect(needs).toEqual([{ venue: 'B', reason: 'new show 6' }]);
    expect(p.next(cs)).toEqual({ kind: 'refresh', venue: 'B', date: '20261217', reason: 'new show 6' });
    expect(p.next(cs)).toMatchObject({ kind: 'probe' }); // only once
  });

  it("doesn't re-read a venue × date within the cooldown (by-movie data can lag ~30 s)", () => {
    const { p, now, advance } = setup();
    const cs = combos(['20261217'], ['A']);
    learned(p, cs, now(), { English: [] });
    const probe = p.next(cs) as PlannerAction & { kind: 'probe' };
    p.onProbe(probe, result('20261217', { A: [['9', '1']] }, ['20261217']), { venues: ['A'], snapshots: new Map([['A', snap('20261217', [])]]) });
    expect(p.next(cs)).toMatchObject({ kind: 'probe' }); // read just now: wait
    advance(91_000);
    expect(p.next(cs)).toMatchObject({ kind: 'refresh', venue: 'A' });
  });

  it('a pending change is dropped once the by-movie data agrees again', () => {
    const { p, now } = setup();
    const cs = combos(['20261217'], ['A']);
    learned(p, cs, now(), { English: [] });
    const probe = p.next(cs) as PlannerAction & { kind: 'probe' };
    const ctx = { venues: ['A'], snapshots: new Map([['A', snap('20261217', [['1', '1']])]]) };
    p.onProbe(probe, result('20261217', { A: [['1', '0']] }, ['20261217']), ctx);
    expect(p.pendingCount).toBe(1);
    p.onProbe(probe, result('20261217', { A: [['1', '1']] }, ['20261217']), ctx);
    expect(p.pendingCount).toBe(0);
  });

  it('safety net: a venue × date not read in full for fullRefreshMs is read before more by-movie requests', () => {
    const { p, now, advance } = setup({ fullRefreshMs: 60 * MIN });
    const cs = combos(['20261217'], ['A', 'B']);
    learned(p, cs, now(), { English: [] });
    p.read('B', '20261217', now() - 30 * MIN);
    advance(31 * MIN);
    expect(p.next(cs)).toEqual({ kind: 'refresh', venue: 'B', date: '20261217', reason: 'full refresh' });
  });

  it('disable() hands control back to the plain rotation for a while', () => {
    const { p, now, advance } = setup();
    const cs = combos(['20261217'], ['A']);
    learned(p, cs, now(), { English: [] });
    p.disable(30 * MIN);
    expect(p.next(cs)).toBeNull();
    advance(31 * MIN);
    readAll(p, cs, now());
    expect(p.next(cs)).toMatchObject({ kind: 'probe' });
  });
});
