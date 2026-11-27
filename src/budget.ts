import { sleep } from './time.js';

/**
 * Token bucket with no burst beyond one minute's allowance spread evenly:
 * requests are released at most every 60 / perMinute seconds.
 */
export class RequestBudget {
  private nextAt = 0;

  constructor(public perMinute: number) {
    if (!(perMinute > 0)) throw new Error('budget must be > 0');
  }

  /** Milliseconds until the next request may be sent. */
  waitMs(now = Date.now()): number {
    return Math.max(0, this.nextAt - now);
  }

  /** Wait for the next slot and claim it. */
  async take(signal?: AbortSignal): Promise<void> {
    const wait = this.waitMs();
    if (wait > 0) await sleep(wait, signal);
    const gap = 60_000 / this.perMinute;
    // small jitter so requests don't land on an exact beat
    this.nextAt = Date.now() + gap * (0.9 + Math.random() * 0.2);
  }
}
