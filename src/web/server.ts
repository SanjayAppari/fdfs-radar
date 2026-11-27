/**
 * Local, read-only dashboard: live shows per venue/date + a Redis key browser.
 * Binds to 127.0.0.1 only. Live updates via Server-Sent Events fed by the
 * watcher's Redis pub/sub channel.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Redis } from 'ioredis';
import { ALERT_LOG_KEY, LIVE_CHANNEL, STATUS_KEY } from '../live.js';
import { log } from '../log.js';

const PORT = Number(process.env.DASHBOARD_PORT ?? 4317);
const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1';
const REDIS_URL = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';
const INDEX_HTML = new URL('../../web/index.html', import.meta.url);
const MAX_KEYS = 2000;
const PREVIEW_CHARS = 240;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const sub = new Redis(REDIS_URL);
const clients = new Set<ServerResponse>();

sub.subscribe(LIVE_CHANNEL).catch((err) => log.error(`subscribe failed: ${err.message}`));
sub.on('message', (_channel, message) => {
  for (const res of clients) res.write(`data: ${message}\n\n`);
});
setInterval(() => {
  for (const res of clients) res.write(`: ping\n\n`);
}, 25_000).unref();

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const parseJSON = (s: string | null) => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

async function scanKeys(pattern: string): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < MAX_KEYS);
  keys.sort();
  return { keys: keys.slice(0, MAX_KEYS), truncated: keys.length >= MAX_KEYS };
}

async function readValue(key: string, type: string): Promise<unknown> {
  switch (type) {
    case 'string':
      return parseJSON(await redis.get(key));
    case 'list':
      return (await redis.lrange(key, 0, 99)).map(parseJSON);
    case 'hash':
      return redis.hgetall(key);
    case 'set':
      return redis.smembers(key);
    case 'zset':
      return redis.zrange(key, 0, 99, 'WITHSCORES');
    default:
      return `(${type})`;
  }
}

async function describeKeys(keys: string[]) {
  if (!keys.length) return [];
  const meta = redis.pipeline();
  for (const k of keys) meta.type(k).pttl(k);
  const metaRes = (await meta.exec()) ?? [];
  const types = keys.map((_, i) => String(metaRes[i * 2]?.[1] ?? 'none'));
  const ttls = keys.map((_, i) => Number(metaRes[i * 2 + 1]?.[1] ?? -2));

  const strings = redis.pipeline();
  keys.forEach((k, i) => types[i] === 'string' && strings.get(k));
  const strRes = (await strings.exec()) ?? [];
  let si = 0;

  return Promise.all(
    keys.map(async (key, i) => {
      const type = types[i]!;
      const raw = type === 'string' ? ((strRes[si++]?.[1] as string | null) ?? '') : JSON.stringify(await readValue(key, type));
      return {
        key,
        type,
        ttlMs: ttls[i],
        size: raw.length,
        preview: raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS)}…` : raw,
      };
    }),
  );
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });

  if (url.pathname === '/') {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`retry: 3000\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/state') {
    const [statusRaw, snapKeys, seatKeys, alertsRaw] = await Promise.all([
      redis.get(STATUS_KEY),
      scanKeys('fdfs:*:snapshot:*'),
      scanKeys('fdfs:*:seats:*'),
      redis.lrange(ALERT_LOG_KEY, 0, 99),
    ]);
    const snapshots = snapKeys.keys.length ? (await redis.mget(...snapKeys.keys)).map(parseJSON).filter(Boolean) : [];
    const seats: Record<string, unknown> = {};
    if (seatKeys.keys.length) {
      for (const r of (await redis.mget(...seatKeys.keys)).map(parseJSON)) {
        if (r && typeof r === 'object') {
          const x = r as { source: string; venue: string; date: string; sessionId: string };
          seats[`${x.source}:${x.venue}:${x.date}:${x.sessionId}`] = r;
        }
      }
    }
    return json(res, 200, {
      status: parseJSON(statusRaw),
      snapshots,
      seats,
      alerts: alertsRaw.map(parseJSON),
      serverTime: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/keys') {
    const pattern = url.searchParams.get('pattern') || 'fdfs:*';
    const { keys, truncated } = await scanKeys(pattern);
    return json(res, 200, { pattern, truncated, keys: await describeKeys(keys) });
  }

  if (url.pathname === '/api/key') {
    const key = url.searchParams.get('k');
    if (!key) return json(res, 400, { error: 'missing k' });
    const type = await redis.type(key);
    if (type === 'none') return json(res, 404, { error: 'not found' });
    return json(res, 200, { key, type, ttlMs: await redis.pttl(key), value: await readValue(key, type) });
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log.error(`dashboard ${req.url}: ${(err as Error).message}`);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
  });
});

server.listen(PORT, HOST, () => log.info(`dashboard on http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const res of clients) res.end();
    server.close();
    sub.disconnect();
    redis.disconnect();
    process.exit(0);
  });
}
