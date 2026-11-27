import 'dotenv/config';
import { loadConfig, loadEnv, type VenueConfig, type WatchConfig } from './config.js';
import { diffSnapshot, isPriority, isWatchedMovie } from './diff.js';
import { layoutKey, LiveFeed, seatsKey, type SeatResult } from './live.js';
import { log } from './log.js';
import { formatAlert, formatMiddleSeats, packMessages, TelegramNotifier } from './notify/telegram.js';
import { analyseSeats, detectRowOrder, expandRows, hallFor, learnedHall, orderOfSpec, seatDirection, sortRows, type LayoutSource, type RowOrder } from './seats.js';
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
  /** Latest snapshot per venue+date, used to pick shows for seat checks */
  latest: Map<string, DateSnapshot>;
  venueByCode: Map<string, VenueConfig>;
  /** sessionKey → last seat check (ms) */
  seatChecked: Map<string, number>;
}

async function pollDate(ctx: Ctx, venue: VenueConfig, date: string): Promise<void> {
  const { cfg, source, store, notifier, live } = ctx;
  const snap = await source.fetchDate(venue, date);
  ctx.latest.set(`${venue.code}:${date}`, snap);
  const watchCfg = { movies: venue.movies, priorityFormats: cfg.priorityFormats };
  const result = await diffSnapshot(store, snap, watchCfg);
  const link = source.bookingUrl(venue, date);
  const watchedCount = snap.shows.filter((s) => isWatchedMovie(s, venue)).length;
  log.info(
    `${venue.code} ${date}: ${snap.status}, ${snap.shows.length} shows (${watchedCount} watched)` +
      (result.baseline ? ' [baseline]' : '') +
      (result.alerts.length ? `, ${result.alerts.length} alert(s)` : ''),
  );

  if (result.alerts.length) {
    const messages = packMessages(result.alerts.map((a) => formatAlert(a, venue.name, link)));
    await notifier.sendAll(messages); // throws → no commit → retried next round
  }
  await result.commit();
  await live.alerts(venue, result.alerts);
  await live.snapshot(venue, snap, link, result.touchedKeys);
  await live.setStatus('ok');
}

const showKey = (s: Show) => `${s.venue}:${s.date}:${s.sessionId}`;

/**
 * Watched, bookable shows whose seat map is due. Never-checked shows go first
 * (and get a bigger per-round budget), then the longest-unchecked. Last-check
 * times fall back to Redis so a restart doesn't reset the queue.
 */
async function dueSeatChecks(ctx: Ctx): Promise<Show[]> {
  const { cfg, latest, seatChecked, store, source, venueByCode } = ctx;
  const today = todayIST();
  const candidates = [...latest.values()]
    .filter((s) => s.status === 'open' && s.date >= today && venueByCode.has(s.venue))
    .flatMap((s) => s.shows)
    .filter((s) => isWatchedMovie(s, venueByCode.get(s.venue)!) && s.availStatus !== '0' && s.eventCode);

  const unknown = candidates.filter((s) => !seatChecked.has(showKey(s)));
  if (unknown.length) {
    const stored = await store.mget(unknown.map((s) => seatsKey(source.name, s.venue, s.date, s.sessionId)));
    unknown.forEach((s, i) => {
      const at = stored[i] ? Date.parse((JSON.parse(stored[i]!) as { checkedAt?: string }).checkedAt ?? '') : Number.NaN;
      seatChecked.set(showKey(s), Number.isFinite(at) ? at : 0);
    });
  }

  const minGap = cfg.seats.minIntervalMinutes * 60_000;
  const now = Date.now();
  const due = candidates
    .filter((s) => now - seatChecked.get(showKey(s))! >= minGap)
    .sort((a, b) => seatChecked.get(showKey(a))! - seatChecked.get(showKey(b))!);
  const neverChecked = due.some((s) => seatChecked.get(showKey(s)) === 0);
  return due.slice(0, neverChecked ? cfg.seats.perRound * 2 : cfg.seats.perRound);
}

async function checkSeats(ctx: Ctx, show: Show): Promise<void> {
  const { cfg, source, store, live } = ctx;
  const venue = ctx.venueByCode.get(show.venue)!;
  ctx.seatChecked.set(showKey(show), Date.now());
  let map;
  try {
    map = await source.fetchSeatMap!(show);
  } catch (err) {
    if (err instanceof SeatMapUnavailable) {
      log.warn(`seats ${venue.code} ${show.date} ${show.time} ${show.screen} (${show.sessionId}) skipped: ${err.message}`);
      return;
    }
    throw err;
  }

  // Left → right: the site lists seats in drawn order. Cross-check with config
  // and, if they ever disagree, follow config (and say so).
  const ltr = venue.screens[show.screen.trim().toUpperCase()]?.leftToRight;
  if (ltr) {
    for (const row of map.rows) {
      const dir = seatDirection(row.seats);
      if (dir && dir !== ltr) {
        log.warn(`${venue.code} ${show.screen} row ${row.row}: site lists seats ${dir}, config says ${ltr} — using config`);
        row.seats.reverse();
      }
    }
  }

  // Hall layout. Direction comes from the site's own row order when it can be
  // read (most reliable), else from what we learned before, else config.
  // Rows: config's letters if given, else A … furthest row ever seen.
  const override = venue.screens[show.screen.trim().toUpperCase()];
  const lKey = layoutKey(source.name, venue.code, show.screen);
  const stored = JSON.parse((await store.get(lKey)) ?? '{}') as { seen?: string[]; order?: RowOrder };
  const seen = [...new Set([...(stored.seen ?? []), ...map.rows.map((r) => r.row)])].sort();
  const detected = detectRowOrder(map.rows);
  const configOrder = override?.rows ? orderOfSpec(override.rows) : null;
  const order = detected ?? stored.order ?? configOrder;
  if (detected && configOrder && detected !== configOrder) {
    log.warn(`${venue.code} ${show.screen}: config rows "${override!.rows}" contradict the site's row order — using the site's`);
  }
  if (seen.length !== (stored.seen ?? []).length || (detected && detected !== stored.order)) {
    await store.writeAll([{ key: lKey, value: JSON.stringify({ seen, order: detected ?? stored.order ?? null, updatedAt: new Date().toISOString() }) }]);
  }

  let hallRows: string[];
  let layoutSource: LayoutSource;
  if (!order) {
    hallRows = sortRows(seen);
    layoutSource = 'unknown';
  } else if (override?.rows) {
    hallRows = hallFor(expandRows(override.rows), order);
    layoutSource = configOrder === order ? 'config' : 'detected';
  } else {
    hallRows = learnedHall(seen);
    hallRows = hallFor(hallRows, order);
    layoutSource = 'detected';
  }

  const summary = analyseSeats(map, {
    hallRows,
    layoutSource,
    policy: cfg.seats.middle,
    goodRowsOverride: override?.goodRows,
  });
  log.info(
    `seats ${venue.code} ${show.date} ${show.time} ${show.screen} (${show.sessionId}): ${summary.totalFree} free, ` +
      `${summary.middleFree} middle, best block ${summary.bestBlock}${summary.middleOk ? ' ✓' : ''}`,
  );

  // 🎯 Alert on the transition to "has middle seats". The new result is only
  // stored after Telegram accepts the message, so a failed send is retried.
  const sKey = seatsKey(source.name, venue.code, show.date, show.sessionId);
  const prev = JSON.parse((await store.get(sKey)) ?? 'null') as SeatResult | null;
  if (cfg.seats.alertMiddle && summary.middleOk && layoutSource !== 'unknown' && !prev?.middleOk) {
    const dedupeKey = `fdfs:${source.name}:${venue.code}:alerted:middle:${show.date}:${show.sessionId}`;
    if ((await store.get(dedupeKey)) === null) {
      const priority = isPriority(show, cfg);
      const link = source.seatMapUrl?.(show) ?? source.bookingUrl(venue, show.date);
      await ctx.notifier.send(formatMiddleSeats({ show, priority }, summary, venue.name, link));
      await store.setNX(dedupeKey, '1', 30 * 60);
      log.info(`middle-seat alert sent for ${show.sessionId}`);
      await live.logAlert({
        date: show.date,
        venue: venue.code,
        venueName: venue.name,
        kind: 'middle_seats',
        priority,
        summary: `Middle seats: ${show.movie} · ${show.dimension} · ${show.time} · ${show.screen} — ${summary.middleFree} free`,
      });
    }
  }

  await live.seats(
    { ...summary, source: source.name, venue: venue.code, date: show.date, sessionId: show.sessionId, screen: show.screen },
    [lKey],
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
    homeVenue: cfg.venues[0]!,
    region: cfg.region,
    userDataDir: env.userDataDir,
    headless: env.headless,
    channel: env.browserChannel,
    reloadEveryMs: cfg.poll.reloadEveryMinutes * 60_000,
  });

  const live = new LiveFeed(store, cfg, source.name);
  const ctx: Ctx = {
    cfg,
    source,
    store,
    notifier,
    live,
    latest: new Map(),
    seatChecked: new Map(),
    venueByCode: new Map(cfg.venues.map((v) => [v.code, v])),
  };
  await live.setStatus('starting');

  for (const v of cfg.venues) {
    log.info(`watching ${v.name} (${v.code}) dates=[${v.dates.join(', ')}] movies=[${v.movies.join(', ') || 'ALL'}]`);
  }
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
        await notifier.send(`✅ <b>Watcher recovered</b> — polling again.`).catch(() => {});
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
      // Date-major order: each date is checked at every venue before moving on.
      const jobs = cfg.dates
        .filter((d) => d >= today)
        .flatMap((date) => cfg.venues.filter((v) => v.dates.includes(date)).map((venue) => ({ venue, date })));
      if (jobs.length === 0) {
        log.warn('all configured dates are in the past — update config.json');
        if (once) break;
        await sleep(30 * 60_000, stop.signal);
        continue;
      }

      for (const [i, { venue, date }] of jobs.entries()) {
        if (stop.signal.aborted) break round;
        if (!(await step(`${venue.code} ${date}`, () => pollDate(ctx, venue, date)))) {
          if (once) break round;
          continue round;
        }
        if (i < jobs.length - 1) await gap();
      }

      if (cfg.seats.enabled && source.fetchSeatMap) {
        for (const show of await dueSeatChecks(ctx)) {
          if (stop.signal.aborted) break round;
          await gap();
          if (!(await step(`seats ${show.venue} ${show.date} ${show.sessionId}`, () => checkSeats(ctx, show)))) {
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
