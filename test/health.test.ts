import { describe, expect, it } from 'vitest';
import { isNetworkError, LogThrottle, networkReason, Reachability } from '../src/health.js';
import { SeatLayoutFormatError } from '../src/sources/seat-layout.js';
import { BlockedError, SeatMapUnavailable } from '../src/sources/types.js';

const MIN = 60_000;
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
// What impit threw during the 28 Nov outage.
const dnsError = named(
  'ConnectError',
  'Failed to connect to the server.\nReason: ... "dns error" ... failed to lookup address information: nodename nor servname provided, or not known',
);

describe('isNetworkError', () => {
  it('recognises DNS, connect, timeout and browser network errors', () => {
    expect(isNetworkError(dnsError)).toBe(true);
    expect(isNetworkError(named('HTTPError', 'The internal HTTP library has thrown an error: reqwest::Error'))).toBe(true);
    expect(isNetworkError(named('TimeoutError', 'request timed out'))).toBe(true);
    expect(isNetworkError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://…'))).toBe(true);
    expect(isNetworkError(new Error('page.goto: net::ERR_INTERNET_DISCONNECTED'))).toBe(true);
  });

  it('the site answering is not a network error', () => {
    expect(isNetworkError(new BlockedError('non-JSON response (HTTP 403)', 403))).toBe(false);
    expect(isNetworkError(new BlockedError('rate limited (HTTP 429)', 429))).toBe(false);
    expect(isNetworkError(new SeatMapUnavailable('site refused the seat layout'))).toBe(false);
    expect(isNetworkError(new SeatLayoutFormatError('could not be decrypted'))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'shows')"))).toBe(false);
  });

  it('gives a readable reason', () => {
    expect(networkReason(dnsError)).toBe('DNS lookup failing');
    expect(networkReason(named('TimeoutError', 'timed out'))).toBe('requests timing out');
    expect(networkReason(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('no network');
  });
});

function setup() {
  let t = 1_000_000;
  const r = new Reachability({ now: () => t });
  return { r, advance: (ms: number) => (t += ms), at: () => t };
}

describe('Reachability', () => {
  it('a short blip is not an outage and is never reported', () => {
    const { r, advance } = setup();
    r.fail('DNS lookup failing');
    advance(2 * MIN);
    r.fail('DNS lookup failing');
    r.fail('DNS lookup failing');
    expect(r.due()).toBeNull();
    r.ok();
    advance(10 * MIN);
    expect(r.due()).toBeNull();
  });

  it('5 min without an answer (and 3+ failures) is an outage: one "down", then one "up" with the times', () => {
    const { r, advance, at } = setup();
    const start = at();
    r.fail('DNS lookup failing');
    advance(5 * MIN);
    r.fail('DNS lookup failing');
    expect(r.due()).toBeNull(); // only 2 failures
    r.fail('DNS lookup failing');
    expect(r.due()).toEqual({ kind: 'down', since: start, reason: 'DNS lookup failing', failures: 3 });
    r.markSent('down');
    expect(r.due()).toBeNull(); // not repeated
    advance(33 * MIN);
    r.fail('DNS lookup failing');
    expect(r.due()).toBeNull();
    r.ok();
    expect(r.due()).toEqual({ kind: 'up', from: start, to: at(), reason: 'DNS lookup failing' });
    r.markSent('up');
    expect(r.due()).toBeNull();
  });

  it('keeps offering a message until Telegram accepts it', () => {
    const { r, advance } = setup();
    for (let i = 0; i < 3; i++) r.fail('x');
    advance(6 * MIN);
    expect(r.due()?.kind).toBe('down');
    expect(r.due()?.kind).toBe('down'); // send failed, not marked
    r.markSent('down');
    r.ok();
    expect(r.due()?.kind).toBe('up');
    expect(r.due()?.kind).toBe('up');
  });

  it('if "down" never got through (Telegram was unreachable too), "up" still reports the whole outage', () => {
    const { r, advance, at } = setup();
    const start = at();
    for (let i = 0; i < 5; i++) r.fail('DNS lookup failing');
    advance(38 * MIN);
    expect(r.due()?.kind).toBe('down'); // never marked sent
    r.ok();
    expect(r.due()).toEqual({ kind: 'up', from: start, to: at(), reason: 'DNS lookup failing' });
    r.markSent('up');
    expect(r.due()).toBeNull(); // the stale "down" is not sent afterwards
  });

  it('a new outage after recovery starts fresh', () => {
    const { r, advance, at } = setup();
    for (let i = 0; i < 3; i++) r.fail('a');
    advance(6 * MIN);
    r.markSent('down');
    r.ok();
    r.markSent('up');
    advance(60 * MIN);
    const second = at();
    for (let i = 0; i < 3; i++) r.fail('b');
    advance(5 * MIN);
    expect(r.due()).toMatchObject({ kind: 'down', since: second, reason: 'b' });
  });
});

describe('LogThrottle', () => {
  it('logs the first line, holds repeats for a minute, then reports how many were held', () => {
    let t = 0;
    const th = new LogThrottle(60_000, () => t);
    expect(th.pass('net', 'ERROR A')).toBe('ERROR A');
    t += 10_000;
    expect(th.pass('net', 'ERROR A')).toBeNull();
    t += 10_000;
    expect(th.pass('net', 'ERROR A')).toBeNull();
    t += 41_000;
    expect(th.pass('net', 'ERROR A')).toBe('ERROR A (+2 similar in the last 61s)');
    expect(th.pass('other', 'ERROR B')).toBe('ERROR B'); // keys are independent
  });
});
