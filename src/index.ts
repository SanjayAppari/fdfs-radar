import 'dotenv/config';
import { loadConfig, loadEnv, type WatchConfig } from './config.js';
import { diffSnapshot, isPriority, isWatchedMovie } from './diff.js';
import { layoutKey, LiveFeed, seatsKey, type SeatResult } from './live.js';
import { log } from './log.js';
import { formatAlert, formatMiddleSeats, packMessages, TelegramNotifier } from './notify/telegram.js';
import { analyseSeats, expandRows, learnedHall } from './seats.js';
import { TicketingSource } from './sources/ticketing.js';
import { BlockedError, SeatMapUnavailable, type DateSnapshot, type Show, type ShowSource } from './sources/types.js';
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

interface Ctx {
  cfg: WatchConfig;
  source: ShowSource;
  store: RedisStore;
  notifier: TelegramNotifier;
  live: LiveFeed;
  /** Latest snapshot per date, used to pick shows for seat checks */
  latest: Map<string, DateSnapshot>;
  /** sessionKey → last seat check (ms) */
  seatChecked: Map<string, number>;
}

async function pollDate(ctx: Ctx, date: string): Promise<void> {
  const { cfg, source, store, notifier, live } = ctx;
  const snap = await source.fetchDate(date);
  ctx.latest.set(date, snap);
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

const showKey = (s: Show) => `${s.date}:${s.sessionId}`;

/** Watched, bookable shows whose seat map is due, oldest check first. */
function dueSeatChecks(ctx: Ctx): Show[] {
  const { cfg, latest, seatChecked } = ctx;
  const today = todayIST();
  const minGap = cfg.seats.minIntervalMinutes * 60_000;
  const now = Date.now();
  return [...latest.values()]
    .filter((s) => s.status === 'open' && s.date >= today)
    .flatMap((s) => s.shows)
    .filter((s) => isWatchedMovie(s, cfg) && s.availStatus !== '0' && s.eventCode)
    .filter((s) => now - (seatChecked.get(showKey(s)) ?? 0) >= minGap)
    .sort((a, b) => (seatChecked.get(showKey(a)) ?? 0) - (seatChecked.get(showKey(b)) ?? 0))
    .slice(0, cfg.seats.perRound);
}

async function checkSeats(ctx: Ctx, show: Show): Promise<void> {
  const { cfg, source, store, live } = ctx;
  ctx.seatChecked.set(showKey(show), Date.now());
  let map;
  try {
    map = await source.fetchSeatMap!(show);
  } catch (err) {
    if (err instanceof SeatMapUnavailable) {
      log.warn(`seats ${show.date} ${show.time} ${show.screen} (${show.sessionId}) skipped: ${err.message}`);
      return;
    }
    throw err;
  }

  // Hall rows: config wins; otherwise learn the union of every row ever seen on this screen.
  const override = cfg.seats.screens[show.screen.trim().toUpperCase()];
  const lKey = layoutKey(source.name, cfg.venue, show.screen);
  let hallRows: string[];
  let layoutSource: 'config' | 'learned';
  if (override?.rows) {
    hallRows = expandRows(override.rows);
    layoutSource = 'config';
  } else {
    const prev = JSON.parse((await store.get(lKey)) ?? '{"seen":[]}') as { seen?: string[] };
    const seen = [...new Set([...(prev.seen ?? []), ...map.rows.map((r) => r.row)])].sort();
    hallRows = learnedHall(seen);
    layoutSource = 'learned';
    if (seen.length !== (prev.seen ?? []).length) {
      await store.writeAll([{ key: lKey, value: JSON.stringify({ seen, hall: hallRows, updatedAt: new Date().toISOString() }) }]);
    }
  }

  const summary = analyseSeats(map, {
    hallRows,
    layoutSource,
    policy: cfg.seats.middle,
    goodRowsOverride: override?.goodRows,
  });
  log.info(
    `seats ${show.date} ${show.time} ${show.screen} (${show.sessionId}): ${summary.totalFree} free, ` +
      `${summary.middleFree} middle, best block ${summary.bestBlock}${summary.middleOk ? ' ✓' : ''}`,
  );

  // 🎯 Alert on the transition to "has middle seats". The new result is only
  // stored after Telegram accepts the message, so a failed send is retried.
  const sKey = seatsKey(source.name, cfg.venue, show.date, show.sessionId);
  const prev = JSON.parse((await store.get(sKey)) ?? 'null') as SeatResult | null;
  if (cfg.seats.alertMiddle && summary.middleOk && !prev?.middleOk) {
    const dedupeKey = `fdfs:${source.name}:${cfg.venue}:alerted:middle:${show.date}:${show.sessionId}`;
    if ((await store.get(dedupeKey)) === null) {
      const priority = isPriority(show, cfg);
      const link = source.seatMapUrl?.(show) ?? source.bookingUrl(show.date);
      await ctx.notifier.send(formatMiddleSeats({ show, priority }, summary, link));
      await store.setNX(dedupeKey, '1', 30 * 60);
      log.info(`middle-seat alert sent for ${show.sessionId}`);
      await live.logAlert({
        date: show.date,
        kind: 'middle_seats',
        priority,
        summary: `Middle seats: ${show.movie} · ${show.dimension} · ${show.time} · ${show.screen} — ${summary.middleFree} free`,
      });
    }
  }

  await live.seats(
    { ...summary, source: source.name, venue: cfg.venue, date: show.date, sessionId: show.sessionId, screen: show.screen },
    layoutSource === 'learned' ? [lKey] : [],
  );
}

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const store = new RedisStore(env.redisUrl);
  await store.ping();
  const notifier = new TelegramNotifier(env.telegramToken, env.telegramChatId);
  const source: ShowSource = new TicketingSource({
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
  const ctx: Ctx = { cfg, source, store, notifier, live, latest: new Map(), seatChecked: new Map() };
  await live.setStatus('starting');

  log.info(`watching ${cfg.venueName} dates=[${cfg.dates.join(', ')}] movies=[${cfg.movies.join(', ') || 'ALL'}]`);
  await source.init();

  let blocked = false;
  let consecutiveErrors = 0;
  const gap = () => sleep(randomBetween(cfg.poll.gapMinSeconds, cfg.poll.gapMaxSeconds) * 1000, stop.signal);

  /** Runs one unit of work. Returns false when the round should be abandoned (blocked). */
  async function step(label: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      consecutiveErrors = 0;
      if (blocked) {
        blocked = false;
        log.info('unblocked');
        await notifier.send(`✅ <b>Watcher recovered</b> — polling ${cfg.venueName} again.`).catch(() => {});
      }
      return true;
    } catch (err) {
      if (err instanceof BlockedError) {
        log.warn(`blocked (${label}): ${err.message}`);
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
        if (!once) await sleep(backoff, stop.signal);
        return false;
      }
      consecutiveErrors++;
      log.error(`${label}: ${(err as Error).stack ?? err}`);
      await live.setStatus('error', `${label}: ${(err as Error).message}`);
      if (consecutiveErrors >= 3) {
        log.warn('3 consecutive errors, recovering source');
        await source.recover().catch((e) => log.error(`recover failed: ${(e as Error).message}`));
        consecutiveErrors = 0;
      }
      return true;
    }
  }

  try {
    round: while (!stop.signal.aborted) {
      const today = todayIST();
      const dates = cfg.dates.filter((d) => d >= today);
      if (dates.length === 0) {
        log.warn('all configured dates are in the past — update config.json');
        if (once) break;
        await sleep(30 * 60_000, stop.signal);
        continue;
      }

      for (const [i, date] of dates.entries()) {
        if (stop.signal.aborted) break round;
        if (!(await step(date, () => pollDate(ctx, date)))) {
          if (once) break round;
          continue round;
        }
        if (i < dates.length - 1) await gap();
      }

      if (cfg.seats.enabled && source.fetchSeatMap) {
        for (const show of dueSeatChecks(ctx)) {
          if (stop.signal.aborted) break round;
          await gap();
          if (!(await step(`seats ${show.date} ${show.sessionId}`, () => checkSeats(ctx, show)))) {
            if (once) break round;
            continue round;
          }
        }
      }

      if (once) break;
      await sleep(randomBetween(cfg.poll.minSeconds, cfg.poll.maxSeconds) * 1000, stop.signal);
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
