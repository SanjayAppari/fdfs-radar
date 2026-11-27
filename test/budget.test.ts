import { describe, expect, it } from 'vitest';
import { RequestBudget, type BudgetStore } from '../src/budget.js';

const memStore = (): BudgetStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    writeAll: async (ws) => ws.forEach((w) => data.set(w.key, w.value)),
  };
};

describe('RequestBudget', () => {
  it('spaces requests at about 60 / perMinute seconds and never bursts', async () => {
    const b = new RequestBudget(4);
    expect(b.waitMs()).toBe(0);
    await b.take();
    expect(b.waitMs()).toBeGreaterThan(15_000 * 0.9);
    expect(b.waitMs()).toBeLessThanOrEqual(15_000 * 1.1 + 5);
  });

  it('runs at half speed while warming up', () => {
    const b = new RequestBudget(4);
    const now = Date.now();
    b.warmUp(10 * 60_000, now);
    expect(b.gapMs(now)).toBe(30_000);
    expect(b.gapMs(now + 11 * 60_000)).toBe(15_000);
  });

  it('is shared through the store: a second instance waits for the first', async () => {
    const store = memStore();
    const a = new RequestBudget(4, store);
    await a.take();
    const b = new RequestBudget(4, store);
    const ctrl = new AbortController();
    const t = Date.now();
    const p = b.take(ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await p;
    expect(Date.now() - t).toBeLessThan(1_000); // it was waiting (aborted), not sending
    expect(Number(store.data.get('fdfs:showtimes-next-at'))).toBeGreaterThan(t);
  });

  it('honours holds requested by rate-limit headers', () => {
    const b = new RequestBudget(4);
    b.hold(Date.now() + 60_000);
    expect(b.waitMs()).toBeGreaterThan(59_000);
  });

  it('rejects a zero budget', () => {
    expect(() => new RequestBudget(0)).toThrow();
  });
});
