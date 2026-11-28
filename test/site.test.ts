import { describe, expect, it } from 'vitest';
import { rateHintFrom, showtimesPath, snapshotFromResponse } from '../src/sources/site.js';
import { BlockedError } from '../src/sources/types.js';
import { fullResponse, META } from './helpers.js';

const res = (over: Partial<{ status: number; contentType: string; retryAfter: string; text: string }>) => ({
  status: 200,
  contentType: 'application/json',
  retryAfter: '',
  text: JSON.stringify(fullResponse()),
  ...over,
});

describe('snapshotFromResponse', () => {
  it('parses a normal JSON response', () => {
    const snap = snapshotFromResponse(res({}), '20261217', META);
    expect(snap.status).toBe('open');
    expect(snap.shows.length).toBeGreaterThan(0);
  });

  it('a bot-check HTML page is a block', () => {
    expect(() => snapshotFromResponse(res({ status: 403, contentType: 'text/html', text: '<!DOCTYPE html>' }), '20261217', META)).toThrow(
      BlockedError,
    );
  });

  it('429 carries Retry-After', () => {
    try {
      snapshotFromResponse(res({ status: 429, retryAfter: '1800', text: '{}' }), '20261217', META);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedError);
      expect((err as BlockedError).httpStatus).toBe(429);
      expect((err as BlockedError).retryAfterSeconds).toBe(1800);
    }
  });
});

describe('rateHintFrom', () => {
  it('reads either header spelling and ignores missing ones', () => {
    const h: Record<string, string> = { 'ratelimit-remaining': '3', 'x-ratelimit-limit': '10' };
    expect(rateHintFrom((k) => h[k] ?? null)).toEqual({ remaining: 3, limit: 10, resetSeconds: undefined, retryAfter: undefined });
  });
});

describe('showtimesPath', () => {
  it('adds a cache-busting parameter only for live requests', () => {
    expect(showtimesPath('PRHN', '20261217', 'HYD', false)).toBe(
      '/api/v3/mobile/showtimes/byvenue?dateCode=20261217&venueCode=PRHN&regionCode=HYD&appCode=WEBV2',
    );
    expect(showtimesPath('PRHN', '20261217', 'HYD', true)).toMatch(/&_=\d+$/);
  });
});
