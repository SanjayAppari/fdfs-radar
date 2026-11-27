import 'dotenv/config';
import { loadConfig, loadEnv, type VenueConfig, type WatchConfig } from './config.js';
import { diffSnapshot, isPriority, isWatchedMovie } from './diff.js';
import { layoutKey, LiveFeed, seatsKey, snapshotKey, type SeatResult } from './live.js';
import { log } from './log.js';
import { formatAlert, formatMiddleSeats, formatRowsOpened, packMessages, TelegramNotifier, type OpenedRow } from './notify/telegram.js';
import { analyseSeats, detectRowOrder, expandRows, hallFor, learnedHall, orderOfSpec, seatDirection, sortRows, type LayoutSource, type RowOrder } from './seats.js';
import { TicketingSource } from './sources/ticketing.js';
import { BlockedError, SeatMapUnavailable, type DateSnapshot, type Show, type ShowSource } from './sources/types.js';
import { RedisStore } from './store.js';
import { RequestBudget } from './budget.js';
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
  /** Shows the fast loop is currently covering (skipped by the regular seat checks) */
  hot: Set<string>;
  /** All loops stay quiet until this time after a bot-check block */
  pausedUntil: number;
  /** Live (uncached) showtimes are off until this time after a rate limit; cached polling continues */
  liveBlockedUntil: number;
  /** Even cached showtimes were refused: no showtime requests at all until this time */
  showtimesPausedUntil: number;
}

async function pollDate(ctx: Ctx, venue: VenueConfig, date: string, fresh = true): Promise<void> {
  const { cfg, source, store, notifier, live } = ctx;
  const snap = await source.fetchDate(venue, date, fresh);
  ctx.latest.set(`${venue.code}:${date}`, snap);
  const watchCfg = { movies: venue.movies, formats: venue.formats, priorityFormats: cfg.priorityFormats };
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
  await resetSoldOutSeats(ctx, snap);
  await live.alerts(venue, result.alerts);
  await live.snapshot(venue, snap, link, result.touchedKeys);
  await live.setStatus('ok');
}

/**
 * Sold-out shows aren't seat-checked, so a stored "has middle seats" result
 * would otherwise go stale and swallow the 🎯 alert when seats come back.
 */
async function resetSoldOutSeats(ctx: Ctx, snap: DateSnapshot): Promise<void> {
  const soldOut = snap.shows.filter((s) => s.availStatus === '0');
  if (!soldOut.length) return;
  const keys = soldOut.map((s) => seatsKey(ctx.source.name, s.venue, s.date, s.sessionId));
  const stored = await ctx.store.mget(keys);
  const writes = stored.flatMap((raw, i) => {
    const r = raw ? (JSON.parse(raw) as SeatResult) : null;
    if (!r?.middleOk) return [];
    log.info(`seats ${soldOut[i]!.venue} ${soldOut[i]!.date} ${soldOut[i]!.time} ${soldOut[i]!.screen}: sold out, clearing middle-seat state`);
    const cleared: SeatResult = { ...r, middleOk: false, middleFree: 0, totalFree: 0, bestBlock: 0, rows: [], checkedAt: new Date().toISOString() };
    return [{ key: keys[i]!, value: JSON.stringify(cleared), ttlSeconds: 14 * 86_400 }];
  });
  await ctx.store.writeAll(writes);
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
    .filter((s) => isWatchedMovie(s, venueByCode.get(s.venue)!) && s.availStatus !== '0' && s.eventCode)
    .filter((s) => !ctx.hot.has(showKey(s)));

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

async function checkSeats(ctx: Ctx, show: Show, slot: 'seat' | 'hot' = 'seat'): Promise<void> {
  const { cfg, source, store, live } = ctx;
  const venue = ctx.venueByCode.get(show.venue)!;
  ctx.seatChecked.set(showKey(show), Date.now());
  let map;
  try {
    map = await source.fetchSeatMap!(show, slot);
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

  // 🎯 Alerts: (a) a show now has middle seats, (b) an already-green show gained
  // a lot more (a row was released). The new result is only stored after
  // Telegram accepts the message, so a failed send is retried.
  const sKey = seatsKey(source.name, venue.code, show.date, show.sessionId);
  const prev = JSON.parse((await store.get(sKey)) ?? 'null') as SeatResult | null;
  let title: string | null = null;
  let kind = 'middle';
  if (cfg.seats.alertMiddle && summary.middleOk && layoutSource !== 'unknown') {
    const gained = summary.middleFree - (prev?.middleFree ?? 0);
    if (!prev?.middleOk) {
      title = 'MIDDLE SEATS';
    } else if (cfg.seats.alertIncrease > 0 && gained >= cfg.seats.alertIncrease) {
      title = `MORE MIDDLE SEATS (+${gained})`;
      kind = 'middle-more';
    }
  }
  // 🔓 Rows that had no free seats at the last check and now do (needs a previous check).
  let opened: OpenedRow[] = [];
  if (cfg.seats.alertRowsOpened && prev) {
    const before = new Map(prev.rows.map((r) => [r.row, r.free]));
    const rowKeys = summary.rows
      .filter((r) => r.free >= cfg.seats.rowUnlockMinSeats && !(before.get(r.row) ?? 0))
      .map((r) => ({ r, key: `fdfs:${source.name}:${venue.code}:alerted:row:${show.date}:${show.sessionId}:${r.row}` }));
    const seen = rowKeys.length ? await store.mget(rowKeys.map((x) => x.key)) : [];
    const fresh = rowKeys.filter((_, i) => seen[i] === null);
    opened = fresh.map(({ r }) => ({
      row: r.row,
      free: r.free,
      middleFree: r.middleFree,
      seats: r.seats.filter((x) => x.free).map((x) => x.n),
    }));
    if (opened.length) {
      for (const { key } of fresh) await store.setNX(key, '1', cfg.seats.alertCooldownMinutes * 60);
    }
  }

  const middleKey = title ? `fdfs:${source.name}:${venue.code}:alerted:${kind}:${show.date}:${show.sessionId}` : null;
  const sendMiddle = middleKey !== null && (await store.get(middleKey)) === null;
  if (sendMiddle || opened.length) {
    const priority = isPriority(show, cfg);
    const link = source.seatMapUrl?.(show) ?? source.bookingUrl(venue, show.date);
    const text = sendMiddle
      ? formatMiddleSeats({ show, priority }, summary, venue.name, link, title!, opened)
      : formatRowsOpened({ show, priority }, summary, opened, venue.name, link);
    await ctx.notifier.send(text);
    if (sendMiddle) await store.setNX(middleKey!, '1', cfg.seats.alertCooldownMinutes * 60);
    const what = [sendMiddle ? title : '', opened.length ? `rows opened ${opened.map((r) => r.row).join(',')}` : ''].filter(Boolean).join(' + ');
    log.info(`alert sent (${what}) for ${venue.code} ${show.sessionId}${slot === 'hot' ? ' (fast loop)' : ''}`);
    await live.logAlert({
      date: show.date,
      venue: venue.code,
      venueName: venue.name,
      kind: sendMiddle ? 'middle_seats' : 'rows_opened',
      priority,
      summary:
        `${sendMiddle ? (title === 'MIDDLE SEATS' ? 'Middle seats' : title) : 'Rows opened'}: ${show.movie} · ${show.dimension} · ${show.time} · ${show.screen}` +
        (opened.length ? ` — ${opened.map((r) => `${r.row}: ${(r.seats ?? []).slice(0, 8).join(', ') || r.free}`).join(' · ')}` : ` — ${summary.middleFree} middle free`),
    });
  }

  await live.seats(
    { ...summary, source: source.name, venue: venue.code, date: show.date, sessionId: show.sessionId, screen: show.screen },
    [lKey],
  );
}

/** Shows for the fast loop: watched, bookable, matching the fast filters; priority formats and earlier dates first. */
function pickHotShows(ctx: Ctx): Show[] {
  const { cfg, latest, venueByCode } = ctx;
  const f = cfg.seats.fast;
  const today = todayIST();
  const fmt = (s: Show) => `${s.attributes} ${s.dimension}`.toLowerCase();
  return [...latest.values()]
    .filter((snap) => snap.status === 'open' && snap.date >= today && venueByCode.has(snap.venue))
    .flatMap((snap) => snap.shows)
    .filter((s) => s.availStatus !== '0' && s.eventCode && isWatchedMovie(s, venueByCode.get(s.venue)!))
    .filter((s) => (!f.venues.length || f.venues.includes(s.venue)) && (!f.dates.length || f.dates.includes(s.date)))
    .filter((s) => !f.formats.length || f.formats.some((x) => fmt(s).includes(x.toLowerCase())))
    .sort(
      (a, b) =>
        Number(isPriority(b, cfg)) - Number(isPriority(a, cfg)) ||
        a.date.localeCompare(b.date) ||
        a.showDateTime.localeCompare(b.showDateTime),
    )
    .slice(0, f.maxShows);
}

/**
 * Fast loop: keeps re-reading the hot shows in their own tab so a released
 * row is noticed within ~intervalSeconds. Runs alongside the main loop.
 */
async function hotLoop(ctx: Ctx): Promise<void> {
  const f = ctx.cfg.seats.fast;
  if (!ctx.cfg.seats.enabled || !f.enabled || f.maxShows === 0 || !ctx.source.fetchSeatMap) return;
  await sleep(30_000, stop.signal); // let the main loop fetch showtimes first
  let lastList = '';
  while (!stop.signal.aborted) {
    if (Date.now() < ctx.pausedUntil) {
      await sleep(ctx.pausedUntil - Date.now(), stop.signal);
      continue;
    }
    const shows = pickHotShows(ctx);
    ctx.hot = new Set(shows.map(showKey));
    const list = shows.map((s) => `${s.venue} ${s.date} ${s.time} ${s.screen}`).join(' | ');
    if (list !== lastList) {
      log.info(`fast loop now watching: ${list || '(nothing bookable matches)'}`);
      await ctx.live.setHot(shows.map((s) => `${s.source}:${s.venue}:${s.date}:${s.sessionId}`));
      lastList = list;
    }
    if (!shows.length) {
      await sleep(20_000, stop.signal);
      continue;
    }
    const started = Date.now();
    for (const show of shows) {
      if (stop.signal.aborted || Date.now() < ctx.pausedUntil) break;
      try {
        await checkSeats(ctx, show, 'hot');
      } catch (err) {
        if (err instanceof BlockedError) {
          const backoff = randomBetween(ctx.cfg.poll.blockedBackoffMinMinutes, ctx.cfg.poll.blockedBackoffMaxMinutes) * 60_000;
          ctx.pausedUntil = Date.now() + backoff;
          log.warn(`fast loop blocked (${err.message}); pausing both loops ${Math.round(backoff / 1000)}s`);
          await ctx.live.setStatus('blocked', err.message);
          break;
        }
        log.warn(`fast loop ${show.venue} ${show.sessionId}: ${(err as Error).message.split('\n')[0]}`);
      }
      await sleep(randomBetween(1, 2.5) * 1000, stop.signal);
    }
    const target = f.intervalSeconds * 1000 * randomBetween(0.85, 1.15);
    const elapsed = Date.now() - started;
    if (elapsed < target) await sleep(target - elapsed, stop.signal);
  }
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
    hot: new Set(),
    pausedUntil: 0,
    liveBlockedUntil: Number((await store.get('fdfs:live-blocked-until')) ?? 0),
    showtimesPausedUntil: Number((await store.get('fdfs:showtimes-paused-until')) ?? 0),
  };

  // Seed the show list from the last saved snapshots, so seat checks can run
  // straight away (and keep running if showtimes are temporarily refused).
  for (const v of cfg.venues) {
    for (const date of v.dates) {
      const raw = await store.get(snapshotKey(source.name, v.code, date));
      if (raw) ctx.latest.set(`${v.code}:${date}`, JSON.parse(raw) as DateSnapshot);
    }
  }
  await live.setStatus('starting');

  for (const v of cfg.venues) {
    log.info(`watching ${v.name} (${v.code}) dates=[${v.dates.join(', ')}] movies=[${v.movies.join(', ') || 'ALL'}]`);
  }
  await source.init();

  let blocked = false;
  let consecutiveErrors = 0;
  /**
   * Hard budget for showtimes requests (the site rate-limits them per
   * connection and locks you out for an hour). Halved on every 429 and
   * remembered in Redis, so the same mistake can't repeat.
   */
  const savedBudget = Number(await store.get('fdfs:poll-budget'));
  const budget = new RequestBudget(Math.min(cfg.poll.requestsPerMinute, savedBudget > 0 ? savedBudget : Infinity), store);
  // Gentle start: half speed for 10 minutes (both lockouts came right after resuming).
  budget.warmUp(10 * 60_000, Math.max(Date.now(), ctx.showtimesPausedUntil));
  log.info(`showtimes budget: ${budget.perMinute} requests/min (half speed for the first 10 min)`);

  /**
   * Runs one unit of work. Returns false when blocked (the caller should drop
   * the rest of its round). The first loop to hit a block sends the single
   * alert, recovers the browser and sets the shared pause; the others just stop.
   */
  async function step(label: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      consecutiveErrors = 0;
      if (blocked && Date.now() >= ctx.pausedUntil) {
        blocked = false;
        log.info('unblocked');
        await notifier.send(`✅ <b>Watcher recovered</b> — polling again.`).catch(() => {});
      }
      return true;
    } catch (err) {
      if (err instanceof BlockedError && err.httpStatus === 429) {
        // Rate limited. Only live (uncached) showtime polling stops; cached
        // polling, seat checks and the fast loop carry on, so we're never blind.
        const wait = (err.retryAfterSeconds ?? 600) * 1000;
        const until = Date.now() + wait;
        if (until > ctx.showtimesPausedUntil) {
          // The API is locked for this connection. Stop sending showtime requests
          // until the site's deadline (more requests may extend it), then warm up slowly.
          ctx.showtimesPausedUntil = until;
          budget.warmUp(10 * 60_000, until);
          await store.writeAll([{ key: 'fdfs:showtimes-paused-until', value: String(until), ttlSeconds: Math.ceil(wait / 1000) + 60 }]);
          log.warn(`showtimes locked (${label}); no showtime requests for ~${Math.round(wait / 60_000)} min`);
          await live.setStatus('error', `rate limited — showtimes paused ~${Math.round(wait / 60_000)} min; seat checks continue`);
        }
        if (until > ctx.liveBlockedUntil) {
          ctx.liveBlockedUntil = until;
          await store.writeAll([{ key: 'fdfs:live-blocked-until', value: String(until), ttlSeconds: Math.ceil(wait / 1000) + 60 }]);
          budget.perMinute = Math.max(1, Math.floor(budget.perMinute / 2));
          await store.writeAll([{ key: 'fdfs:poll-budget', value: String(budget.perMinute), ttlSeconds: 7 * 86_400 }]);
          log.warn(`showtimes budget lowered to ${budget.perMinute}/min (saved for 7 days)`);
          const mins = Math.round(wait / 60_000);
          log.warn(`rate limited (${label}); showtimes paused ~${mins} min`);
          await live.setStatus('error', `rate limited — showtimes paused ~${mins} min; seat checks continue`);
          if (await store.setNX('fdfs:alerted:ratelimited', '1', 3600)) {
            await notifier
              .send(
                `⏳ <b>Rate limited</b> by the site for ~${mins} min. New-show checks pause until then; ` +
                  `seat checks continue. Request budget lowered to ${budget.perMinute}/min so it won't repeat.`,
              )
              .catch(() => {});
          }
        }
        return true;
      }
      if (err instanceof BlockedError) {
        if (Date.now() < ctx.pausedUntil) return false; // another loop is already handling it
        const backoff = randomBetween(cfg.poll.blockedBackoffMinMinutes, cfg.poll.blockedBackoffMaxMinutes) * 60_000;
        ctx.pausedUntil = Date.now() + backoff;
        log.warn(`blocked (${label}): ${err.message}; pausing all loops ${Math.round(backoff / 1000)}s`);
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
        return false;
      }
      consecutiveErrors++;
      log.error(`${label}: ${(err as Error).stack ?? err}`);
      await live.setStatus('error', `${label}: ${(err as Error).message}`);
      if (consecutiveErrors >= 5) {
        log.warn('5 consecutive errors, recovering source');
        await source.recover().catch((e) => log.error(`recover failed: ${(e as Error).message}`));
        consecutiveErrors = 0;
      }
      return true;
    }
  }

  const waitIfPaused = async () => {
    if (Date.now() < ctx.pausedUntil) await sleep(ctx.pausedUntil - Date.now() + 1_000, stop.signal);
  };

  /** Regular seat checks, in their own tab so they never delay showtime polling. */
  async function seatLoop(): Promise<void> {
    if (!cfg.seats.enabled || !source.fetchSeatMap) return;
    await sleep(15_000, stop.signal);
    while (!stop.signal.aborted) {
      await waitIfPaused();
      const due = await dueSeatChecks(ctx);
      if (!due.length) {
        await sleep(10_000, stop.signal);
        continue;
      }
      for (const show of due) {
        if (stop.signal.aborted || Date.now() < ctx.pausedUntil) break;
        await step(`seats ${show.venue} ${show.date} ${show.sessionId}`, () => checkSeats(ctx, show));
        await sleep(randomBetween(2, 4) * 1000, stop.signal);
      }
    }
  }

  const seats = once ? Promise.resolve() : seatLoop().catch((e) => log.error(`seat loop crashed: ${(e as Error).stack ?? e}`));
  const fast = once ? Promise.resolve() : hotLoop(ctx).catch((e) => log.error(`fast loop crashed: ${(e as Error).stack ?? e}`));

  try {
    // Showtimes scheduler: one request at a time under a hard per-minute budget.
    // Every request is live (the site's limiter counts cached ones too). Each slot
    // goes to the venue × date that is most overdue, priority dates weighted ×4.
    const lastFetched = new Map<string, number>();
    let sent = 0;
    let summaryAt = Date.now();
    while (!stop.signal.aborted) {
      await waitIfPaused();
      if (Date.now() < ctx.showtimesPausedUntil) {
        await sleep(Math.min(ctx.showtimesPausedUntil - Date.now() + 2_000, 60_000), stop.signal);
        continue;
      }
      const today = todayIST();
      const upcoming = cfg.dates.filter((d) => d >= today);
      if (!upcoming.length) {
        log.warn('all configured dates are in the past — update config.json');
        if (once) break;
        await sleep(30 * 60_000, stop.signal);
        continue;
      }
      const priority = new Set(cfg.poll.liveDates.length ? cfg.poll.liveDates : upcoming.slice(0, 2));
      const isPriority = (c: { venue: VenueConfig; date: string }) => priority.has(c.date) || priority.has(`${c.venue.code}:${c.date}`);
      const combos = upcoming.flatMap((date) => cfg.venues.filter((v) => v.dates.includes(date)).map((venue) => ({ venue, date })));
      const now = Date.now();
      const pick = combos
        .map((c) => {
          const k = `${c.venue.code}:${c.date}`;
          const age = now - (lastFetched.get(k) ?? 0);
          return { ...c, k, score: age * (isPriority(c) ? 4 : 1) };
        })
        .sort((a, b) => b.score - a.score)[0]!;

      await budget.take(stop.signal);
      if (stop.signal.aborted) break;
      lastFetched.set(pick.k, Date.now());
      sent++;
      await step(`${pick.venue.code} ${pick.date}`, () => pollDate(ctx, pick.venue, pick.date, true));
      // Early warning: if the site says few requests remain, back off before hitting zero.
      const hint = (source as TicketingSource).lastRateHint ?? {};
      if (hint.remaining !== undefined && hint.limit && hint.remaining <= Math.max(2, hint.limit * 0.2)) {
        const holdMs = (hint.resetSeconds ?? hint.retryAfter ?? 60) * 1000;
        budget.hold(Date.now() + holdMs);
        log.warn(`site reports ${hint.remaining}/${hint.limit} requests left; holding showtimes ${Math.round(holdMs / 1000)}s`);
      }

      if (once && sent >= combos.length) {
        if (cfg.seats.enabled && source.fetchSeatMap) {
          for (const show of await dueSeatChecks(ctx)) await step(`seats ${show.sessionId}`, () => checkSeats(ctx, show));
        }
        break;
      }
      if (Date.now() - summaryAt >= 60_000) {
        const pri = combos.filter(isPriority);
        const oldest = (list: typeof combos) =>
          Math.round(Math.max(0, ...list.map((c) => Date.now() - (lastFetched.get(`${c.venue.code}:${c.date}`) ?? Date.now()))) / 1000);
        log.info(
          `showtimes: ${sent} requests in the last minute (budget ${budget.perMinute}/min); ` +
            `${pri.length} priority combos refreshed within ${oldest(pri)}s, others within ${oldest(combos.filter((c) => !isPriority(c)))}s`,
        );
        sent = 0;
        summaryAt = Date.now();
      }
    }
  } finally {
    stop.abort();
    await Promise.all([fast, seats]);
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
