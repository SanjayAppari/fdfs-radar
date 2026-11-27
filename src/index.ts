import 'dotenv/config';
import { loadConfig, loadEnv, type WatchConfig } from './config.js';
import { diffSnapshot, isWatchedMovie } from './diff.js';
import { LiveFeed } from './live.js';
import { log } from './log.js';
import { formatAlert, packMessages, TelegramNotifier } from './notify/telegram.js';
import { TicketingSource } from './sources/ticketing.js';
import { BlockedError, type ShowSource } from './sources/types.js';
import { RedisStore } from './store.js';
import { randomBetween, sleep, todayIST } from './time.js';

const once = process.argv.includes('--once');
const stop = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} received, shutting down`);
    stop.abort();
  });
}

async function pollDate(
  date: string,
  source: ShowSource,
  store: RedisStore,
  notifier: TelegramNotifier,
  cfg: WatchConfig,
  live: LiveFeed,
): Promise<void> {
  const snap = await source.fetchDate(date);
  const result = await diffSnapshot(store, snap, cfg);
  const link = source.bookingUrl(date);
  const watchedCount = snap.shows.filter((s) => isWatchedMovie(s, cfg)).length;
  log.info(
    `${date}: ${snap.status}, ${snap.shows.length} shows (${watchedCount} watched)` +
      (result.baseline ? ' [baseline]' : '') +
      (result.alerts.length ? `, ${result.alerts.length} alert(s)` : ''),
  );

  if (result.alerts.length) {
    const messages = packMessages(result.alerts.map((a) => formatAlert(a, cfg.venueName, link)));
    await notifier.sendAll(messages); // throws → no commit → retried next round
  }
  await result.commit();
  await live.alerts(result.alerts);
  await live.snapshot(snap, link, result.touchedKeys);
  await live.setStatus('ok');
}

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const store = new RedisStore(env.redisUrl);
  await store.ping();
  const notifier = new TelegramNotifier(env.telegramToken, env.telegramChatId);
  const source = new TicketingSource({
    baseUrl: env.baseUrl,
    venue: cfg.venue,
    venueSlug: cfg.venueSlug,
    region: cfg.region,
    userDataDir: env.userDataDir,
    headless: env.headless,
    channel: env.browserChannel,
    reloadEveryMs: cfg.poll.reloadEveryMinutes * 60_000,
  });

  const live = new LiveFeed(store, cfg, source.name);
  await live.setStatus('starting');

  log.info(`watching ${cfg.venueName} dates=[${cfg.dates.join(', ')}] movies=[${cfg.movies.join(', ') || 'ALL'}]`);
  await source.init();

  let blocked = false;
  let consecutiveErrors = 0;

  try {
    while (!stop.signal.aborted) {
      const today = todayIST();
      const dates = cfg.dates.filter((d) => d >= today);
      if (dates.length === 0) {
        log.warn('all configured dates are in the past — update config.json');
        if (once) break;
        await sleep(30 * 60_000, stop.signal);
        continue;
      }

      for (const [i, date] of dates.entries()) {
        if (stop.signal.aborted) break;
        try {
          await pollDate(date, source, store, notifier, cfg, live);
          consecutiveErrors = 0;
          if (blocked) {
            blocked = false;
            log.info('unblocked');
            await notifier.send(`✅ <b>Watcher recovered</b> — polling ${cfg.venueName} again.`).catch(() => {});
          }
        } catch (err) {
          if (err instanceof BlockedError) {
            log.warn(`blocked: ${err.message}`);
            await live.setStatus('blocked', err.message);
            if (!blocked) {
              blocked = true;
              // One alert per blocked episode, also deduped across restarts.
              if (await store.setNX('fdfs:alerted:blocked', '1', 3600)) {
                await notifier
                  .send(`⚠️ <b>Watcher blocked</b> by the site's bot check. Backing off 5–10 min and reloading.`)
                  .catch((e) => log.error(`telegram: ${(e as Error).message}`));
              }
            }
            await source.recover().catch((e) => log.error(`recover failed: ${(e as Error).message}`));
            const backoff = randomBetween(cfg.poll.blockedBackoffMinMinutes, cfg.poll.blockedBackoffMaxMinutes) * 60_000;
            log.info(`backing off ${Math.round(backoff / 1000)}s`);
            if (once) break;
            await sleep(backoff, stop.signal);
            break; // restart the round
          }
          consecutiveErrors++;
          log.error(`${date}: ${(err as Error).stack ?? err}`);
          await live.setStatus('error', `${date}: ${(err as Error).message}`);
          if (consecutiveErrors >= 3) {
            log.warn('3 consecutive errors, recovering source');
            await source.recover().catch((e) => log.error(`recover failed: ${(e as Error).message}`));
            consecutiveErrors = 0;
          }
        }
        if (i < dates.length - 1) {
          await sleep(randomBetween(cfg.poll.gapMinSeconds, cfg.poll.gapMaxSeconds) * 1000, stop.signal);
        }
      }

      if (once) break;
      const wait = randomBetween(cfg.poll.minSeconds, cfg.poll.maxSeconds) * 1000;
      await sleep(wait, stop.signal);
    }
  } finally {
    await live.setStatus('stopped');
    await source.close();
    await store.close();
    log.info('stopped');
  }
}

main().catch((err) => {
  log.error(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
