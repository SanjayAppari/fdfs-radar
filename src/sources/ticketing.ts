import type { BrowserContext, Page } from 'playwright';
import { log } from '../log.js';
import { mergeGeometry } from '../layouts.js';
import { detectSeatBoxes, type DetectedGeometry } from './seat-geometry.js';
import { todayIST } from '../time.js';
import {
  BlockedError,
  SeatMapUnavailable,
  type DateSnapshot,
  type SeatMap,
  type SeatRow,
  type Show,
  type ShowSource,
  type VenueRef,
} from './types.js';

import { bookingUrl, rateHintFrom, seatMapUrl, showtimesPath, snapshotFromResponse, type RateHint } from './site.js';

// The parser lives in site.ts (shared with the HTTP source); re-exported for existing imports.
export { parseByVenue } from './site.js';

// ---------------------------------------------------------------------------
// Playwright-backed source
// ---------------------------------------------------------------------------

export interface TicketingSourceOptions {
  /** e.g. https://in.example.com — kept in .env, not in the repo */
  baseUrl: string;
  /** Venue page opened once to establish the browser session */
  homeVenue: VenueRef;
  region: string;
  userDataDir: string;
  headless: boolean;
  /** Optional: "chrome" to use the installed Google Chrome instead of bundled Chromium */
  channel?: string;
  reloadEveryMs: number;
  fetchTimeoutMs?: number;
  viewport?: { width: number; height: number };
}

interface PageFetchResult {
  status: number;
  contentType: string;
  cache: string;
  retryAfter: string;
  rlRemaining: string;
  rlLimit: string;
  rlReset: string;
  text: string;
}

export class TicketingSource implements ShowSource {
  readonly name = 'ticketing';
  private context?: BrowserContext;
  private page?: Page;
  /** Second tab used only for seat maps, so the venue page stays loaded. */
  private seatPage?: Page;
  /** Third tab for the hot-show loop, so it never collides with the normal seat checks. */
  private hotPage?: Page;
  private lastLoadAt = 0;
  /** Shared in-flight reload, so parallel fetches wait for one reload instead of racing it. */
  private reloading?: Promise<void>;
  /** Last cache status seen on the showtimes API (HIT/MISS/…), for diagnostics */
  lastCacheStatus = '';
  /** Rate-limit hints from the last successful response, when the site sends them */
  lastRateHint: RateHint = {};

  constructor(private readonly opts: TicketingSourceOptions) {}

  bookingUrl(venue: VenueRef, date: string): string {
    return bookingUrl(this.opts.baseUrl, this.opts.region, venue, date);
  }

  async init(): Promise<void> {
    const { chromium } = await import('playwright');
    this.context = await chromium.launchPersistentContext(this.opts.userDataDir, {
      headless: this.opts.headless,
      channel: this.opts.channel || undefined,
      viewport: this.opts.viewport ?? { width: 1280, height: 860 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.loadVenuePage();
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) await this.init();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context!.newPage();
      await this.loadVenuePage();
    }
    return this.page!;
  }

  private async loadVenuePage(): Promise<void> {
    const page = this.page!;
    const url = this.bookingUrl(this.opts.homeVenue, todayIST());
    log.info(`opening venue page ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.waitForChallenge(page);
    this.lastLoadAt = Date.now();
  }

  /** Give an interstitial challenge up to 60s to clear on its own. */
  private async waitForChallenge(page: Page): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const title = (await page.title().catch(() => '')).toLowerCase();
      if (!/just a moment|attention required|verify you are human/.test(title)) return;
      await page.waitForTimeout(2_000);
    }
    log.warn('challenge page did not clear within 60s');
  }

  /** `live`: bypass the CDN cache (fresh data, counts towards the site's rate limit). */
  async fetchDate(venueRef: VenueRef, date: string, live = true): Promise<DateSnapshot> {
    const page = await this.ensurePage();
    if (this.reloading) await this.reloading;
    if (Date.now() - this.lastLoadAt > this.opts.reloadEveryMs) {
      this.reloading ??= (async () => {
        log.info('periodic reload to refresh cookies');
        await this.reload();
      })().finally(() => {
        this.reloading = undefined;
      });
      await this.reloading;
    }

    const venue = venueRef.code;
    const path = showtimesPath(venue, date, this.opts.region, live);

    const res = await page.evaluate(
      async ({ path, timeoutMs, live }): Promise<PageFetchResult> => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await fetch(path, {
            credentials: 'include',
            cache: live ? 'no-store' : 'default',
            headers: { accept: 'application/json, text/plain, */*' },
            signal: ctrl.signal,
          });
          return {
            status: r.status,
            contentType: r.headers.get('content-type') ?? '',
            cache: r.headers.get('cf-cache-status') ?? '',
            retryAfter: r.headers.get('retry-after') ?? '',
            rlRemaining: r.headers.get('x-ratelimit-remaining') ?? r.headers.get('ratelimit-remaining') ?? '',
            rlLimit: r.headers.get('x-ratelimit-limit') ?? r.headers.get('ratelimit-limit') ?? '',
            rlReset: r.headers.get('x-ratelimit-reset') ?? r.headers.get('ratelimit-reset') ?? '',
            text: await r.text(),
          };
        } finally {
          clearTimeout(t);
        }
      },
      { path, timeoutMs: this.opts.fetchTimeoutMs ?? 30_000, live },
    );

    this.lastCacheStatus = res.cache;
    const headers: Record<string, string> = {
      'x-ratelimit-remaining': res.rlRemaining,
      'x-ratelimit-limit': res.rlLimit,
      'x-ratelimit-reset': res.rlReset,
      'retry-after': res.retryAfter,
    };
    this.lastRateHint = rateHintFrom((h) => headers[h] || null);
    return snapshotFromResponse(res, date, { source: this.name, venue });
  }

  seatMapUrl(show: Show): string {
    return seatMapUrl(this.opts.baseUrl, this.opts.region, show);
  }

  /**
   * Reads seat availability through the site's own accessibility seat
   * selection dialog (the visual map is a canvas). Read-only: it picks
   * "1 ticket" to list seats but never selects or holds a seat.
   */
  /** `slot` picks the browser tab: 'seat' for regular checks, 'hot' for the fast loop. */
  fetchSeatMap(show: Show, slot: 'seat' | 'hot' = 'seat'): Promise<SeatMap> {
    return this.readSeatMap(show, undefined, slot);
  }

  /**
   * Seat map plus the drawn geometry (seat box positions on the canvas), used
   * to capture hall templates for the dashboard.
   */
  async captureLayout(show: Show): Promise<{ map: SeatMap; geometry: DetectedGeometry }> {
    let geometry: DetectedGeometry = { error: 'not captured', size: 0, lines: [] };
    const map = await this.readSeatMap(show, async (page) => {
      await page.waitForTimeout(1_500); // let the canvas finish drawing
      geometry = await page.evaluate(detectSeatBoxes);
      // Wide halls overflow the fixed-size drawing area: zoom out until nothing touches the edge.
      const zoomOut = page.locator('div:has(> svg use[href*="icon-zoom-out"])').first();
      for (let i = 0; i < 5 && geometry.clipped; i++) {
        await zoomOut.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(900);
        geometry = await page.evaluate(detectSeatBoxes);
      }
      // Still too wide: pan across and merge passes until nothing new appears.
      const cv = await page.evaluate(() => {
        const c = [...document.querySelectorAll('canvas')].sort((x, y) => y.width * y.height - x.width * x.height)[0]!;
        const r = c.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, scale: c.width / r.width };
      });
      for (const dir of [-1, 1]) {
        for (let i = 0; i < 4 && geometry.clipped; i++) {
          const before = geometry.lines.reduce((n, l) => n + l.xs.length, 0);
          const cx = cv.x + cv.w / 2;
          const cy = cv.y + cv.h / 2;
          await page.mouse.move(cx, cy);
          await page.mouse.down();
          await page.mouse.move(cx + dir * cv.w * 0.35, cy, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(900);
          const next = await page.evaluate(detectSeatBoxes);
          // Content moved by dir*0.35*w css px, so b → a is the opposite shift, in canvas px.
          geometry = { ...mergeGeometry(geometry, next, -dir * cv.w * 0.35 * cv.scale), clipped: next.clipped };
          if (geometry.lines.reduce((n, l) => n + l.xs.length, 0) === before) break; // reached the edge
        }
      }
      geometry = { ...geometry, clipped: false };
    });
    return { map, geometry };
  }

  private async readSeatMap(show: Show, onMapReady?: (page: Page) => Promise<void>, slot: 'seat' | 'hot' = 'seat'): Promise<SeatMap> {
    await this.ensurePage();
    let page: Page;
    if (slot === 'hot') {
      if (!this.hotPage || this.hotPage.isClosed()) this.hotPage = await this.context!.newPage();
      page = this.hotPage;
    } else {
      if (!this.seatPage || this.seatPage.isClosed()) this.seatPage = await this.context!.newPage();
      page = this.seatPage;
    }
    const t = 20_000;

    try {
      const url = this.seatMapUrl(show);
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          break;
        } catch (err) {
          // The site sometimes replaces the navigation client-side (ERR_ABORTED).
          if (!/ERR_ABORTED|frame was detached/i.test((err as Error).message)) throw err;
          await page.waitForTimeout(1_500);
          if (page.url().includes('/seat-layout/')) break;
          if (attempt >= 2) throw new SeatMapUnavailable(`navigation aborted twice (now at ${new URL(page.url() || 'about:blank', this.opts.baseUrl).pathname})`);
        }
      }
      await this.waitForChallenge(page);

      const a11yBtn = page.getByLabel('Open accessibility seat selection');
      try {
        await a11yBtn.waitFor({ state: 'visible', timeout: 30_000 });
      } catch {
        const title = (await page.title().catch(() => '')).toLowerCase();
        if (/just a moment|attention required|verify you are human/.test(title)) {
          throw new BlockedError('challenge page on seat map');
        }
        if (!page.url().includes('/seat-layout/')) {
          throw new SeatMapUnavailable(`redirected away from seat map (to ${new URL(page.url()).pathname})`);
        }
        throw new SeatMapUnavailable(`seat map did not load for session ${show.sessionId}`);
      }

      // The site sometimes never finishes loading a show's seats.
      const loading = page.getByText('Please wait, while we load the seats', { exact: false }).first();
      if (await loading.isVisible().catch(() => false)) {
        const cleared = await loading.waitFor({ state: 'hidden', timeout: 12_000 }).then(() => true, () => false);
        if (!cleared) throw new SeatMapUnavailable('the site is still loading seats for this show');
      }
      await this.dismissQuantityPopup(page);
      if (onMapReady) await onMapReady(page);

      await this.clickThrough(page, a11yBtn);
      const qty = page.locator('select[aria-label="Select number of tickets, required"]');
      const catSel = page.locator('select[aria-label="Select seat category"]');
      const rowSel = page.locator('select[aria-label="Select row"]');
      try {
        await qty.waitFor({ state: 'visible', timeout: t });
      } catch {
        // Usually the site is still (or again) loading this show's seats.
        const stillLoading = await page.getByText('Please wait, while we load the seats', { exact: false }).first().isVisible().catch(() => false);
        throw new SeatMapUnavailable(stillLoading ? 'the site is still loading seats for this show' : 'seat dialog did not open');
      }
      const quantities = await qty.evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => o.value));
      if (!quantities.includes('1')) {
        // Nothing on sale (every class sold out on the seat page): a valid "0 free" result.
        return { source: this.name, venue: show.venue, date: show.date, sessionId: show.sessionId, screen: show.screen, checkedAt: new Date().toISOString(), rows: [] };
      }
      await qty.selectOption('1', { timeout: 8_000 });

      const optionsOf = (loc: typeof catSel) =>
        loc.evaluate((el) =>
          [...(el as HTMLSelectElement).options].filter((o) => o.value).map((o) => ({ value: o.value, text: o.textContent?.trim() ?? '' })),
        );

      const rows: SeatRow[] = [];
      try {
        await catSel.waitFor({ state: 'visible', timeout: 12_000 });
      } catch {
        throw new SeatMapUnavailable('seat classes did not load (the site is likely still loading seats)');
      }
      for (const cat of await optionsOf(catSel)) {
        await catSel.selectOption(cat.value);
        const [catName = cat.text, price = ''] = cat.text.split(/\s+-\s+₹/);
        // Rows only exist for categories with free seats; give the list a moment to populate.
        const rowOpts = await page
          .waitForFunction(
            () => ((document.querySelector('select[aria-label="Select row"]') as HTMLSelectElement | null)?.options.length ?? 0) > 1,
            undefined,
            { timeout: 4_000 },
          )
          .then(() => optionsOf(rowSel))
          .catch(() => []);

        for (const r of rowOpts) {
          const letter = /Row\s+(\S+)\s*$/i.exec(r.text)?.[1] ?? r.value.split('-').pop() ?? r.value;
          await rowSel.selectOption(r.value);
          await page.waitForFunction(
            (row) =>
              [...document.querySelectorAll('button[aria-label]')].some((b) =>
                (b.getAttribute('aria-label') ?? '').endsWith(` in row ${row}`),
              ),
            letter,
            { timeout: t },
          );
          const seats = await page.evaluate((row) => {
            const out: { n: string; free: boolean }[] = [];
            for (const b of document.querySelectorAll('button[aria-label]')) {
              // "Select seat 8 in row C", "Select Best seat 10 in row G" (bestseller), "Booked seat 9 in row C"
              const m = /^(.*?)\s*seat\s+(\S+)\s+in row\s+(\S+)$/i.exec(b.getAttribute('aria-label') ?? '');
              if (m && m[3] === row && !/accessib/i.test(m[1]!)) out.push({ n: m[2]!, free: /^select\b/i.test(m[1]!) });
            }
            return out;
          }, letter);
          rows.push({ row: letter, category: catName.trim(), price: price.trim(), seats });
        }
      }

      return {
        source: this.name,
        venue: show.venue,
        date: show.date,
        sessionId: show.sessionId,
        screen: show.screen,
        checkedAt: new Date().toISOString(),
        rows,
      };
    } finally {
      // Leave the seat page so it doesn't keep polling in the background.
      await page.goto('about:blank').catch(() => {});
    }
  }

  /**
   * The "How many seats?" pop-up can appear a second or two after the page
   * looks ready (especially on repeat visits), so wait for it briefly.
   */
  private async dismissQuantityPopup(page: Page, waitMs = 3_000): Promise<void> {
    const confirm = page.getByText('Select Seats', { exact: true }).first();
    const shown = await confirm.waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false);
    if (!shown) return;
    // Best effort: something (a tooltip or offer banner) can sit on top of the button.
    const ok = await confirm
      .click({ timeout: 4_000 })
      .then(() => true)
      .catch(() => confirm.click({ timeout: 3_000, force: true }).then(() => true, () => false));
    if (!ok) await page.keyboard.press('Escape').catch(() => {});
    await confirm.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  /** Click; if something intercepts it (late pop-up, tooltip), clear it and retry, then force. */
  private async clickThrough(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
    try {
      await target.click({ timeout: 6_000 });
    } catch {
      await this.dismissQuantityPopup(page, 1_000);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      await target.click({ timeout: 6_000, force: true });
    }
  }

  private async reload(): Promise<void> {
    const page = await this.ensurePage();
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await this.waitForChallenge(page);
      this.lastLoadAt = Date.now();
    } catch (err) {
      log.warn(`reload failed, re-navigating: ${(err as Error).message}`);
      await this.loadVenuePage();
    }
  }

  async recover(): Promise<void> {
    if (!this.context) return this.init();
    try {
      await this.reload();
    } catch (err) {
      log.warn(`recover via reload failed (${(err as Error).message}); relaunching browser`);
      await this.close();
      await this.init();
    }
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    this.seatPage = undefined;
    this.hotPage = undefined;
    await ctx?.close().catch(() => {});
  }
}
