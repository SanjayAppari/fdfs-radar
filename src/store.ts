import { Redis } from 'ioredis';

export interface KVWrite {
  key: string;
  value: string;
  ttlSeconds?: number;
}

/** Minimal key/value surface the diff needs; Redis in prod, in-memory in tests. */
export interface KV {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  /** Set only if absent. Returns true if this call created the key. */
  setNX(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  writeAll(writes: KVWrite[]): Promise<void>;
  close(): Promise<void>;
}

export class RedisStore implements KV {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  get(key: string) {
    return this.redis.get(key);
  }

  async mget(keys: string[]) {
    return keys.length ? this.redis.mget(...keys) : [];
  }

  async setNX(key: string, value: string, ttlSeconds: number) {
    return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async writeAll(writes: KVWrite[]) {
    if (!writes.length) return;
    const multi = this.redis.multi();
    for (const w of writes) {
      if (w.ttlSeconds) multi.set(w.key, w.value, 'EX', w.ttlSeconds);
      else multi.set(w.key, w.value);
    }
    await multi.exec();
  }

  async publish(channel: string, message: string) {
    await this.redis.publish(channel, message);
  }

  /** LPUSH + LTRIM: keep the newest `max` entries. */
  async pushCapped(key: string, value: string, max: number) {
    await this.redis.multi().lpush(key, value).ltrim(key, 0, max - 1).exec();
  }

  async close() {
    await this.redis.quit().catch(() => {});
  }
}

export class MemoryStore implements KV {
  readonly data = new Map<string, string>();

  async get(key: string) {
    return this.data.get(key) ?? null;
  }

  async mget(keys: string[]) {
    return keys.map((k) => this.data.get(k) ?? null);
  }

  async setNX(key: string, value: string) {
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    return true;
  }

  async writeAll(writes: KVWrite[]) {
    for (const w of writes) this.data.set(w.key, w.value);
  }

  async close() {}
}
