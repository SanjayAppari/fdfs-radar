import { sleep } from './time.js';

/** Minimal store surface (Redis in production) so the budget is shared across restarts/processes. */
export interface BudgetStore {
  get(key: string): Promise<string | null>;
  writeAll(writes: { key: string; value: string; ttlSeconds?: number }[]): Promise<void>;
}

const NEXT_KEY = 'fdfs:showtimes-next-at';

/**
 * Spaces showtimes requests at least 60 / perMinute seconds apart — never a
 * burst. The next allowed time lives in the store, so a restart or a second
 * process (e.g. `npm run once`) waits its turn instead of adding requests.
 * During a warm-up window (after start or after a lockout) it runs at half speed.
 */
export class RequestBudget {
  private nextAt = 0;
  private warmUntil = 0;
  /** Temporary extra spacing requested by the site's rate-limit headers */
  private holdUntil = 0;

  constructor(
    public perMinute: number,
    private readonly store?: BudgetStore,
  ) {
    if (!(perMinute > 0)) throw new Error('budget must be > 0');
  }

  /** Run at half speed until `ms` from now. */
  warmUp(ms: number, now = Date.now()): void {
    this.warmUntil = Math.max(this.warmUntil, now + ms);
  }

  /** Send nothing until `until`. */
  hold(until: number): void {
    this.holdUntil = Math.max(this.holdUntil, until);
  }

  /** Current spacing between requests, in ms. */
  gapMs(now = Date.now()): number {
    const rate = now < this.warmUntil ? this.perMinute / 2 : this.perMinute;
    return 60_000 / rate;
  }

  /** Milliseconds until the next request may be sent (local view). */
  waitMs(now = Date.now()): number {
    return Math.max(0, this.nextAt - now, this.holdUntil - now);
  }

  /** Wait for the next slot and claim it. */
  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const shared = this.store ? Number((await this.store.get(NEXT_KEY)) ?? 0) : 0;
      if (shared > this.nextAt) this.nextAt = shared;
      const wait = this.waitMs();
      if (wait <= 0) break;
      await sleep(wait, signal);
      if (signal?.aborted) return;
    }
    // small jitter so requests don't land on an exact beat
    this.nextAt = Date.now() + this.gapMs() * (0.95 + Math.random() * 0.15);
    await this.store?.writeAll([{ key: NEXT_KEY, value: String(this.nextAt), ttlSeconds: 3600 }]);
  }
}
