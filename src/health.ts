/**
 * Is the site reachable at all? Tracks network-level failures (DNS, refused
 * connections, timeouts) separately from the site's own answers: a bot check
 * or a refused seat map still means the site answered.
 *
 * Pure (clock injected); the watcher polls due() and sends what it returns,
 * calling markSent() only after Telegram accepted it, so messages retry.
 */

/** Errors that mean the request never got a real answer from the site. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/^(ConnectError|TimeoutError|ConnectTimeout|ReadTimeout|WriteTimeout|PoolTimeout|NetworkError|ReadError|WriteError|CloseError|ProxyError|ProxyTunnelError|RemoteProtocolError)$/.test(err.name)) return true;
  return /dns error|failed to connect|internal HTTP library|lookup address|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_|TIMED_OUT|ADDRESS_UNREACHABLE)|socket hang up|timed? ?out/i.test(
    err.message,
  );
}

/** A short, readable reason for an outage message. */
export function networkReason(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/dns error|lookup address|ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/i.test(msg)) return 'DNS lookup failing';
  if (/timed? ?out|TIMEOUT/i.test(msg)) return 'requests timing out';
  if (/INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH|ADDRESS_UNREACHABLE/i.test(msg)) return 'no network';
  if (/ECONNREFUSED|ECONNRESET|CONNECTION_/i.test(msg)) return 'connections refused or dropped';
  return 'cannot connect';
}

export type HealthMessage =
  | { kind: 'down'; since: number; reason: string; failures: number }
  | { kind: 'up'; from: number; to: number; reason: string };

export interface ReachabilityOptions {
  /** How long without any answer before it counts as an outage (default 5 min) */
  downAfterMs?: number;
  /** …and at least this many failed requests in that time (default 3) */
  minFailures?: number;
  now?: () => number;
}

export class Reachability {
  private readonly downAfterMs: number;
  private readonly minFailures: number;
  private readonly now: () => number;
  /** First network failure since the last answer (undefined = reachable) */
  private failingSince?: number;
  private failures = 0;
  private reason = '';
  private downSent = false;
  /** An outage that ended and still has to be reported */
  private pendingUp?: { from: number; to: number; reason: string };

  constructor(opts: ReachabilityOptions = {}) {
    this.downAfterMs = opts.downAfterMs ?? 5 * 60_000;
    this.minFailures = opts.minFailures ?? 3;
    this.now = opts.now ?? Date.now;
  }

  /** The site answered (any answer). */
  ok(): void {
    if (this.failingSince === undefined) return;
    // Only outages long enough to have counted are reported as ended.
    if (this.isDown() || this.downSent) {
      this.pendingUp = { from: this.failingSince, to: this.now(), reason: this.reason };
    }
    this.failingSince = undefined;
    this.failures = 0;
    this.downSent = false;
  }

  /** A request failed at the network level. */
  fail(reason: string): void {
    this.failingSince ??= this.now();
    this.failures++;
    this.reason = reason;
  }

  /** Currently in an outage (long enough, enough failures)? */
  isDown(): boolean {
    return this.failingSince !== undefined && this.now() - this.failingSince >= this.downAfterMs && this.failures >= this.minFailures;
  }

  /** When the current outage started, if there is one */
  get since(): number | undefined {
    return this.isDown() ? this.failingSince : undefined;
  }

  /** The message to send now, if any ("back online" first: it carries the full story). */
  due(): HealthMessage | null {
    if (this.pendingUp) return { kind: 'up', ...this.pendingUp };
    if (this.isDown() && !this.downSent) return { kind: 'down', since: this.failingSince!, reason: this.reason, failures: this.failures };
    return null;
  }

  /** Call after Telegram accepted the message returned by due(). */
  markSent(kind: HealthMessage['kind']): void {
    if (kind === 'up') this.pendingUp = undefined;
    else this.downSent = true;
  }
}

/** Logs a repeated message at most once per interval, with a count of the ones held back. */
export class LogThrottle {
  private readonly last = new Map<string, { at: number; held: number }>();
  constructor(
    private readonly everyMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the line to log (with "+N similar"), or null to stay quiet. */
  pass(key: string, line: string): string | null {
    const t = this.now();
    const e = this.last.get(key);
    if (e && t - e.at < this.everyMs) {
      e.held++;
      return null;
    }
    this.last.set(key, { at: t, held: 0 });
    return e?.held ? `${line} (+${e.held} similar in the last ${Math.round((t - e.at) / 1000)}s)` : line;
  }
}
