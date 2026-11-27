import { describe, expect, it } from 'vitest';
import { RequestBudget } from '../src/budget.js';

describe('RequestBudget', () => {
  it('spaces requests at roughly 60 / perMinute seconds and never bursts', async () => {
    const b = new RequestBudget(5);
    expect(b.waitMs()).toBe(0);
    await b.take();
    const wait = b.waitMs();
    expect(wait).toBeGreaterThan(60_000 / 5 * 0.85);
    expect(wait).toBeLessThanOrEqual(60_000 / 5 * 1.1 + 5);
  });

  it('rejects a zero budget', () => {
    expect(() => new RequestBudget(0)).toThrow();
  });
});
