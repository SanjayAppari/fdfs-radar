import { describe, expect, it, vi } from 'vitest';
import { FallbackSource, type SwitchEvent } from '../src/sources/fallback.js';
import { SeatLayoutFormatError } from '../src/sources/seat-layout.js';
import { BlockedError, SeatMapUnavailable, type DateSnapshot, type SeatMap, type Show, type ShowSource } from '../src/sources/types.js';

const MIN = 60_000;
const snap = (by: string): DateSnapshot => ({ source: 'ticketing', venue: by, date: '20261217', status: 'open', openDates: null, shows: [] });
const map = (by: string): SeatMap => ({ source: 'ticketing', venue: by, date: '', sessionId: '', screen: '', checkedAt: '', rows: [] });
const SHOW = { venue: 'PRHN', sessionId: '1' } as Show;

/** A fake source whose next results/errors are queued per job; empty queue = success. */
function fake(name: string) {
  const fail = { showtimes: [] as Error[], seats: [] as Error[] };
  const src = {
    name: 'ticketing',
    init: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    bookingUrl: () => `${name}-booking`,
    seatMapUrl: () => `${name}-seat`,
    fetchDate: vi.fn(async () => {
      const e = fail.showtimes.shift();
      if (e) throw e;
      return snap(name);
    }),
    fetchSeatMap: vi.fn(async () => {
      const e = fail.seats.shift();
      if (e) throw e;
      return map(name);
    }),
  } satisfies ShowSource;
  return { src, fail };
}

function setup() {
  let t = 1_000_000;
  const http = fake('http');
  const browser = fake('browser');
  const events: SwitchEvent[] = [];
  const fb = new FallbackSource(http.src, browser.src, { onSwitch: (e) => void events.push(e), now: () => t });
  return { fb, http, browser, events, advance: (ms: number) => (t += ms) };
}

const blocked = () => new BlockedError('non-JSON response (HTTP 403, text/html)', 403);

describe('FallbackSource', () => {
  it('uses plain HTTP and never starts the browser while it works', async () => {
    const { fb, browser } = setup();
    await fb.init();
    expect((await fb.fetchDate({ code: 'X', slug: '' }, '20261217')).venue).toBe('http');
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('http');
    expect(browser.src.init).not.toHaveBeenCalled();
  });

  it('on a bot check, switches that job to the browser and retries the same call there', async () => {
    const { fb, http, browser, events } = setup();
    http.fail.showtimes.push(blocked());
    expect((await fb.fetchDate({ code: 'X', slug: '' }, '20261217')).venue).toBe('browser');
    expect(browser.src.init).toHaveBeenCalledOnce();
    expect(events).toMatchObject([{ job: 'showtimes', to: 'browser' }]);
    expect(fb.mode).toEqual({ showtimes: 'browser', seats: 'http' });
    // Seat maps are unaffected.
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('http');
  });

  it('an unreadable seat layout moves only seat maps to the browser', async () => {
    const { fb, http } = setup();
    http.fail.seats.push(new SeatLayoutFormatError('seat layout could not be decrypted'));
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('browser');
    expect(fb.mode).toEqual({ showtimes: 'http', seats: 'browser' });
  });

  it('passes rate limits and skips straight through (the browser cannot help)', async () => {
    const { fb, http, browser } = setup();
    http.fail.showtimes.push(new BlockedError('rate limited (HTTP 429)', 429, 600));
    await expect(fb.fetchDate({ code: 'X', slug: '' }, '20261217')).rejects.toMatchObject({ httpStatus: 429 });
    http.fail.seats.push(new SeatMapUnavailable('show closed'));
    await expect(fb.fetchSeatMap(SHOW)).rejects.toBeInstanceOf(SeatMapUnavailable);
    expect(browser.src.init).not.toHaveBeenCalled();
    expect(fb.mode).toEqual({ showtimes: 'http', seats: 'http' });
  });

  it('stays on the browser until the retry time, then returns to HTTP when it works', async () => {
    const { fb, http, events, advance } = setup();
    http.fail.seats.push(blocked());
    await fb.fetchSeatMap(SHOW);
    http.src.fetchSeatMap.mockClear();

    advance(29 * MIN);
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('browser');
    expect(http.src.fetchSeatMap).not.toHaveBeenCalled();

    advance(2 * MIN);
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('http');
    expect(fb.mode.seats).toBe('http');
    expect(events.map((e) => e.to)).toEqual(['browser', 'http']);
  });

  it('backs off 30 → 60 → 120 → 240 min while HTTP keeps failing', async () => {
    const { fb, http, events, advance } = setup();
    http.fail.seats.push(blocked());
    await fb.fetchSeatMap(SHOW); // switch; retry in 30
    const waits: number[] = [];
    for (const wait of [30, 60, 120, 240, 240]) {
      advance((wait - 1) * MIN);
      http.src.fetchSeatMap.mockClear();
      await fb.fetchSeatMap(SHOW);
      expect(http.src.fetchSeatMap).not.toHaveBeenCalled(); // too early
      advance(MIN);
      http.fail.seats.push(blocked());
      expect((await fb.fetchSeatMap(SHOW)).venue).toBe('browser'); // tested, failed, browser used
      expect(http.src.fetchSeatMap).toHaveBeenCalledOnce();
      waits.push(wait);
    }
    expect(waits).toEqual([30, 60, 120, 240, 240]);
    expect(events).toHaveLength(1); // only the first switch is announced
  });

  it('announces one switch when parallel calls fail together', async () => {
    const { fb, http, events, browser } = setup();
    http.fail.seats.push(blocked(), blocked());
    const [a, b] = await Promise.all([fb.fetchSeatMap(SHOW), fb.fetchSeatMap(SHOW)]);
    expect([a.venue, b.venue]).toEqual(['browser', 'browser']);
    expect(events).toHaveLength(1);
    expect(browser.src.init).toHaveBeenCalledOnce();
  });

  it('while one call tests HTTP again, parallel calls keep using the browser', async () => {
    const { fb, http, advance } = setup();
    http.fail.seats.push(blocked());
    await fb.fetchSeatMap(SHOW);
    advance(31 * MIN);
    http.src.fetchSeatMap.mockClear();
    const [a, b] = await Promise.all([fb.fetchSeatMap(SHOW), fb.fetchSeatMap(SHOW)]);
    expect(http.src.fetchSeatMap).toHaveBeenCalledOnce();
    expect([a.venue, b.venue].sort()).toEqual(['browser', 'http']);
  });

  it('if the browser cannot start, the error says so and the next call tries again', async () => {
    const { fb, http, browser } = setup();
    browser.src.init.mockRejectedValueOnce(new Error("Executable doesn't exist"));
    http.fail.seats.push(blocked());
    await expect(fb.fetchSeatMap(SHOW)).rejects.toThrow(/browser fallback could not start/);
    expect((await fb.fetchSeatMap(SHOW)).venue).toBe('browser');
    expect(browser.src.init).toHaveBeenCalledTimes(2);
  });

  it('recover() only touches the browser once it has started', async () => {
    const { fb, http, browser } = setup();
    await fb.recover();
    expect(http.src.recover).toHaveBeenCalledOnce();
    expect(browser.src.recover).not.toHaveBeenCalled();
  });

  it('refuses sources with different names (Redis keys would split)', () => {
    const a = fake('http').src;
    const b = { ...fake('browser').src, name: 'other' };
    expect(() => new FallbackSource(a, b)).toThrow(/share one name/);
  });
});
