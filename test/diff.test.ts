import { beforeEach, describe, expect, it } from 'vitest';
import { diffSnapshot, isPriority } from '../src/diff.js';
import { formatAlert, packMessages } from '../src/notify/telegram.js';
import { parseByVenue } from '../src/sources/ticketing.js';
import type { DateSnapshot } from '../src/sources/types.js';
import { MemoryStore } from '../src/store.js';
import { fullResponse, loadShowDetails, META } from './helpers.js';

const CFG = { movies: ['avengers', 'DUNE'], priorityFormats: ['Infinity Vision', 'PCX'] };
const DATE = '20261217';

const snapFrom = (mutate?: (details: any) => void): DateSnapshot => {
  const details = loadShowDetails();
  mutate?.(details);
  return parseByVenue(fullResponse({ details }), DATE, META);
};
const notOpen = (): DateSnapshot => parseByVenue(fullResponse(), '20261218', META);

const avengers3d = (d: any) => d.Event.find((e: any) => e.EventTitle.startsWith('Avengers')).ChildEvents[1];

async function run(store: MemoryStore, snap: DateSnapshot, cfg = CFG) {
  const r = await diffSnapshot(store, snap, cfg);
  await r.commit();
  return r;
}

describe('diffSnapshot', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('first run is baseline only: state stored, no alerts', async () => {
    const r = await run(store, snapFrom());
    expect(r.baseline).toBe(true);
    expect(r.alerts).toEqual([]);
    const stored = JSON.parse((await store.get(`fdfs:ticketing:PRHN:show:${DATE}:259268`))!);
    expect(stored).toEqual({
      movie: 'Dune: Part Three',
      eventName: 'Dune: Part Three (HDR By Barco) - English',
      dimension: 'HDR By Barco',
      screen: 'SCREEN 4',
      attributes: '',
      time: '06:00 PM',
      availStatus: '1',
    });
  });

  it('no changes → no alerts', async () => {
    await run(store, snapFrom());
    expect((await run(store, snapFrom())).alerts).toEqual([]);
  });

  it('alerts on a new SessionId for a watched movie, with 🔥 for priority formats', async () => {
    await run(store, snapFrom());
    const r = await run(
      store,
      snapFrom((d) => {
        const child = avengers3d(d);
        child.ShowTimes.push({ ...child.ShowTimes[0], SessionId: '999001', ShowTime: '11:59 PM', AvailStatus: '1' });
      }),
    );
    expect(r.alerts).toHaveLength(1);
    const a = r.alerts[0]!;
    expect(a.kind).toBe('new_show');
    if (a.kind !== 'new_show') throw new Error();
    expect(a.item.show.sessionId).toBe('999001');
    expect(a.item.priority).toBe(true);
    expect(formatAlert(a, 'Prasads Multiplex', 'https://example.test/x').startsWith('🔥 <b>NEW SHOW</b>')).toBe(true);
  });

  it('ignores new sessions for movies not in the watch list', async () => {
    await run(store, snapFrom());
    const r = await run(
      store,
      snapFrom((d) => {
        d.Event.push({
          EventTitle: 'Some Other Film',
          ChildEvents: [{ EventName: 'Some Other Film - Telugu', EventCode: 'ET1', EventDimension: '2D', ShowTimes: [{ SessionId: '777', ShowTime: '09:00 AM', ScreenName: 'SCREEN 2', Attributes: '', AvailStatus: '1' }] }],
        });
      }),
    );
    expect(r.alerts).toEqual([]);
  });

  it('empty movies list watches everything', async () => {
    await run(store, snapFrom(), { ...CFG, movies: [] });
    const r = await run(
      store,
      snapFrom((d) => {
        d.Event.push({ EventTitle: 'Some Other Film', ChildEvents: [{ EventName: 'x', EventDimension: '2D', ShowTimes: [{ SessionId: '777', AvailStatus: '0' }] }] });
      }),
      { ...CFG, movies: [] },
    );
    expect(r.alerts.map((a) => a.kind)).toEqual(['new_show']);
  });

  it('alerts on AvailStatus 0 → 1 only (not 1 → 0)', async () => {
    await run(store, snapFrom());
    const up = await run(store, snapFrom((d) => (avengers3d(d).ShowTimes[0].AvailStatus = '1')));
    expect(up.alerts).toHaveLength(1);
    expect(up.alerts[0]!.kind).toBe('avail_up');

    const down = await run(store, snapFrom((d) => (avengers3d(d).ShowTimes[0].AvailStatus = '0')));
    expect(down.alerts).toEqual([]);
  });

  it('dedupes: a flapping 0→1→0→1 session alerts once (within the dedupe window)', async () => {
    await run(store, snapFrom());
    const set = (v: string) => snapFrom((d) => (avengers3d(d).ShowTimes[0].AvailStatus = v));
    expect((await run(store, set('1'))).alerts).toHaveLength(1);
    await run(store, set('0'));
    expect((await run(store, set('1'))).alerts).toEqual([]);
  });

  it('alerts once when a watched date opens, summarising shows', async () => {
    const first = await run(store, notOpen()); // baseline while closed
    expect(first.baseline).toBe(true);

    const opened = parseByVenue(fullResponse({ details: { ...loadShowDetails(), Date: '20261218' }, dates: [{ DateCode: '20261218', isDisabled: false }] }), '20261218', META);
    const r = await run(store, opened);
    expect(r.alerts.map((a) => a.kind)).toEqual(['date_open']);
    const a = r.alerts[0]!;
    if (a.kind !== 'date_open') throw new Error();
    expect(a.shows).toHaveLength(11);
    expect(a.shows.filter((s) => s.priority)).toHaveLength(9); // 8 Infinity Vision + 1 PCX

    // Next poll with the same data: nothing new.
    expect((await run(store, opened)).alerts).toEqual([]);

    // Date flaps closed then open again: no duplicate "date open" alert.
    await run(store, notOpen());
    expect((await run(store, opened)).alerts).toEqual([]);
  });

  it('does not persist state when commit is skipped (failed send is retried)', async () => {
    await run(store, snapFrom());
    const changed = snapFrom((d) => (avengers3d(d).ShowTimes[0].AvailStatus = '1'));
    const r1 = await diffSnapshot(store, changed, CFG); // no commit
    expect(r1.alerts).toHaveLength(1);
    const r2 = await diffSnapshot(store, changed, CFG);
    expect(r2.alerts).toHaveLength(1);
  });

  it('venue_down touches nothing', async () => {
    await run(store, snapFrom());
    const before = new Map(store.data);
    const r = await run(store, snapFrom((d) => (d.Venues.isVenueDown = true)));
    expect(r.alerts).toEqual([]);
    expect(store.data).toEqual(before);
  });
});

describe('priority + formatting', () => {
  const shows = snapFrom().shows;

  it('matches priority against Attributes or EventDimension, case-insensitive', () => {
    const byId = (id: string) => shows.find((s) => s.sessionId === id)!;
    expect(isPriority(byId('259079'), { priorityFormats: ['infinity vision'] })).toBe(true); // attributes
    expect(isPriority(byId('259268'), { priorityFormats: ['barco'] })).toBe(true); // dimension
    expect(isPriority(byId('259087'), { priorityFormats: ['infinity vision', 'barco'] })).toBe(false);
    expect(isPriority(byId('259087'), { priorityFormats: [] })).toBe(false);
  });

  it('message contains movie, format, screen + attributes, date, time, status and link', () => {
    const show = shows.find((s) => s.sessionId === '259271')!;
    const text = formatAlert({ kind: 'new_show', date: DATE, item: { show, priority: true } }, 'Prasads Multiplex', 'https://example.test/book/20261217');
    for (const part of ['Dune: Part Three', '2D', 'SCREEN 6 · PCX Screen', 'Thu, 17 Dec 2026', '08:20 PM', '✅ Available', 'href="https://example.test/book/20261217"']) {
      expect(text).toContain(part);
    }
  });

  it('escapes HTML and packs long batches under the Telegram limit', () => {
    const show = { ...shows[0]!, movie: 'A <b> & B' };
    expect(formatAlert({ kind: 'new_show', date: DATE, item: { show, priority: false } }, 'V', 'u')).toContain('A &lt;b&gt; &amp; B');
    const msgs = packMessages(Array.from({ length: 50 }, () => 'x'.repeat(300)));
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.length <= 3900)).toBe(true);
  });
});

describe('new screen / new format tags', () => {
  it('flags a new show on a screen and format the movie did not have that day', async () => {
    const store = new MemoryStore();
    await run(store, snapFrom());
    const r = await run(
      store,
      snapFrom((d) => {
        const child = avengers3d(d);
        child.ShowTimes.push({ ...child.ShowTimes[0], SessionId: '999101', ScreenName: 'SCREEN 9', Attributes: 'IMAX', AvailStatus: '1' });
        child.ShowTimes.push({ ...child.ShowTimes[0], SessionId: '999102', ScreenName: 'SCREEN 3', AvailStatus: '1' });
      }),
    );
    const byId = new Map(r.alerts.filter((a) => a.kind === 'new_show').map((a) => [a.kind === 'new_show' ? a.item.show.sessionId : '', a]));
    const imax = byId.get('999101')!;
    const same = byId.get('999102')!;
    if (imax.kind !== 'new_show' || same.kind !== 'new_show') throw new Error();
    expect(imax.item.newScreen).toBe(true);
    expect(imax.item.newFormat).toBe(true);
    expect(same.item.newScreen).toBe(false);
    expect(same.item.newFormat).toBe(false);
    expect(formatAlert(imax, 'AMB Cinemas', 'u')).toContain('🆕 new screen for this movie · new format for this movie');
  });
});
