import type { BrowserContext, Page } from 'playwright';
import { log } from '../log.js';
import { todayIST } from '../time.js';
import { BlockedError, type DateSnapshot, type Show, type ShowSource } from './types.js';

// ---------------------------------------------------------------------------
// Parser (pure, unit-tested against fixtures/)
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Accepts either the full byvenue response ({ ShowDatesArray, ShowDetails[] })
 * or a bare ShowDetails[0] object (what the fixture contains).
 */
export function parseByVenue(
  json: unknown,
  date: string,
  meta: { source: string; venue: string },
): DateSnapshot {
  const base = { source: meta.source, venue: meta.venue, date };
  if (!json || typeof json !== 'object') {
    return { ...base, status: 'not_open', openDates: null, shows: [] };
  }

  const root = json as Json;

  const openDates: string[] | null = Array.isArray(root.ShowDatesArray)
    ? root.ShowDatesArray.filter((d: Json) => !isTruthyFlag(d?.isDisabled)).map((d: Json) => str(d?.DateCode))
    : null;

  const details: Json | undefined = Array.isArray(root.ShowDetails)
    ? root.ShowDetails[0]
    : root.Event
      ? root
      : undefined;

  if (!details || str(details.Date) !== date) {
    return { ...base, status: 'not_open', openDates, shows: [] };
  }
  if (openDates && !openDates.includes(date)) {
    return { ...base, status: 'not_open', openDates, shows: [] };
  }
  if (isTruthyFlag(details.Venues?.isVenueDown)) {
    return { ...base, status: 'venue_down', openDates, shows: [] };
  }

  const shows: Show[] = [];
  for (const ev of asArray(details.Event)) {
    const movie = str(ev.EventTitle);
    for (const child of asArray(ev.ChildEvents)) {
      for (const st of asArray(child.ShowTimes)) {
        const sessionId = str(st.SessionId);
        if (!sessionId) continue;
        shows.push({
          ...base,
          sessionId,
          movie,
          eventName: str(child.EventName),
          eventCode: str(child.EventCode),
          dimension: str(child.EventDimension),
          screen: str(st.ScreenName),
          attributes: str(st.Attributes),
          time: str(st.ShowTime),
          showDateTime: str(st.ShowDateTime),
          availStatus: str(st.AvailStatus),
        });
      }
    }
  }
  return { ...base, status: 'open', openDates, shows };
}

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || str(v).toLowerCase() === 'true' || str(v).toUpperCase() === 'Y';
}

// ---------------------------------------------------------------------------
// Playwright-backed source
// ---------------------------------------------------------------------------

export interface TicketingSourceOptions {
  /** e.g. https://in.example.com — kept in .env, not in the repo */
  baseUrl: string;
  venue: string;
  venueSlug: string;
  region: string;
  userDataDir: string;
  headless: boolean;
  /** Optional: "chrome" to use the installed Google Chrome instead of bundled Chromium */
  channel?: string;
  reloadEveryMs: number;
  fetchTimeoutMs?: number;
}

interface PageFetchResult {
  status: number;
  contentType: string;
  text: string;
}

export class TicketingSource implements ShowSource {
  readonly name = 'ticketing';
  private context?: BrowserContext;
  private page?: Page;
  private lastLoadAt = 0;

  constructor(private readonly opts: TicketingSourceOptions) {}

  bookingUrl(date: string): string {
    const { baseUrl, region, venueSlug, venue } = this.opts;
    return `${baseUrl}/cinemas/${region}/${venueSlug}/buytickets/${venue}/${date}`;
  }

  async init(): Promise<void> {
    const { chromium } = await import('playwright');
    this.context = await chromium.launchPersistentContext(this.opts.userDataDir, {
      headless: this.opts.headless,
      channel: this.opts.channel || undefined,
      viewport: { width: 1280, height: 860 },
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
    const url = this.bookingUrl(todayIST());
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

  async fetchDate(date: string): Promise<DateSnapshot> {
    const page = await this.ensurePage();
    if (Date.now() - this.lastLoadAt > this.opts.reloadEveryMs) {
      log.info('periodic reload to refresh cookies');
      await this.reload();
    }

    const { venue, region } = this.opts;
    const path =
      `/api/v3/mobile/showtimes/byvenue?dateCode=${date}` +
      `&venueCode=${encodeURIComponent(venue)}&regionCode=${encodeURIComponent(region)}&appCode=WEBV2`;

    const res = await page.evaluate(
      async ({ path, timeoutMs }): Promise<PageFetchResult> => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await fetch(path, {
            credentials: 'include',
            headers: { accept: 'application/json, text/plain, */*' },
            signal: ctrl.signal,
          });
          return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: await r.text() };
        } finally {
          clearTimeout(t);
        }
      },
      { path, timeoutMs: this.opts.fetchTimeoutMs ?? 30_000 },
    );

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new BlockedError(
        `non-JSON response (HTTP ${res.status}, ${res.contentType || 'no content-type'}): ${res.text.slice(0, 120).replace(/\s+/g, ' ')}`,
        res.status,
      );
    }
    if (res.status >= 400) {
      throw new BlockedError(`HTTP ${res.status} with JSON body`, res.status);
    }
    return parseByVenue(json, date, { source: this.name, venue });
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
    await ctx?.close().catch(() => {});
  }
}
