/**
 * Captures a hall template (seat columns, aisles, gap rows) for every screen
 * at every configured venue and writes layouts.json, which the dashboard uses
 * to draw seat maps exactly like the site.
 *
 *   npm run capture-layouts                     # all venues, all screens
 *   npm run capture-layouts -- AMBH             # one venue
 *   npm run capture-layouts -- AMBH "SCREEN 2"  # one screen
 *
 * Uses its own browser profile, so it can run while the watcher is running.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, loadEnv } from '../config.js';
import { buildTemplate, layoutId, readLayouts } from '../layouts.js';
import { log } from '../log.js';
import { expandRows, seatDirection } from '../seats.js';
import { TicketingSource } from '../sources/ticketing.js';
import type { Show } from '../sources/types.js';
import { Redis } from 'ioredis';
import { sleep } from '../time.js';

const [onlyVenue, onlyScreen] = process.argv.slice(2).map((a) => a.toUpperCase());
const OUT = resolve(process.env.LAYOUTS_PATH ?? 'layouts.json');

async function main() {
  const cfg = loadConfig();
  const env = loadEnv();
  const source = new TicketingSource({
    baseUrl: env.baseUrl,
    homeVenue: cfg.venues[0]!,
    region: cfg.region,
    userDataDir: resolve('.browser-profile-capture'),
    headless: env.headless,
    channel: env.browserChannel,
    reloadEveryMs: 45 * 60_000,
    viewport: { width: 2400, height: 1800 }, // big enough that every hall is drawn whole
  });
  await source.init();
  const redis = new Redis(env.redisUrl);
  const layouts = readLayouts(OUT);
  const failures: string[] = [];

  try {
    for (const venue of cfg.venues) {
      if (onlyVenue && venue.code !== onlyVenue) continue;

      // One show per screen, from the watcher's saved snapshots — no showtimes
      // requests here, so capturing never spends the site's rate limit.
      const pick = new Map<string, Show>();
      for (const key of await redis.keys(`fdfs:${source.name}:${venue.code}:snapshot:*`)) {
        const snap = JSON.parse((await redis.get(key)) ?? 'null') as { shows?: Show[] } | null;
        for (const s of snap?.shows ?? []) {
          const cur = pick.get(s.screen);
          if (!cur || (cur.availStatus === '0' && s.availStatus !== '0')) pick.set(s.screen, s);
        }
      }
      log.info(`${venue.code}: screens ${[...pick.keys()].sort().join(', ')}`);

      for (const [screen, show] of [...pick].sort()) {
        if (onlyScreen && screen.toUpperCase() !== onlyScreen) continue;
        const hint = venue.screens[screen.toUpperCase()];
        if (!hint?.rows) {
          failures.push(`${venue.code} ${screen}: no "rows" in config, skipped`);
          continue;
        }
        try {
          const { map, geometry } = await source.captureLayout(show);
          const topToBottom = expandRows(hint.rows).reverse(); // config is screen → back
          const ltr = hint.leftToRight ?? seatDirection(map.rows[0]?.seats ?? []) ?? 'asc';
          const t = buildTemplate(venue.code, screen, geometry, topToBottom, map.rows, ltr);
          layouts[layoutId(venue.code, screen)] = t;
          writeFileSync(OUT, `${JSON.stringify(layouts, null, 1)}\n`);
          log.info(`${venue.code} ${screen}: ${t.rows.length} rows, ${t.cols} columns, ${t.lines} lines (${t.rows.reduce((n, r) => n + r.seats.length, 0)} seats)`);
        } catch (err) {
          failures.push(`${venue.code} ${screen}: ${(err as Error).message}`);
        }
        await sleep(2_000);
      }
    }
  } finally {
    await source.close();
    redis.disconnect();
  }
  for (const f of failures) log.warn(f);
  log.info(`wrote ${OUT}`);
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
