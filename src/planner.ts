/**
 * Decides what each showtimes request slot is spent on when by-movie change
 * detection is on. In order:
 *   1. a venue × date the by-movie data says has changed (read it in full now),
 *   2. a venue × date not read in full for `fullRefreshMs` (safety net),
 *   3. the next by-movie request (movie × language × date), priority dates
 *      getting `priorityShare` of these.
 * Returns null when it can't help (nothing learned yet, disabled, …): the
 * caller then uses the plain per-venue rotation. Pure (clock injected).
 */
import type { ByMovieResult } from './sources/by-movie.js';
import type { DateSnapshot } from './sources/types.js';
import { venuesToRefresh } from './probe.js';

export interface Combo {
  venue: string;
  date: string;
  priority: boolean;
}

export type PlannerAction =
  | { kind: 'refresh'; venue: string; date: string; reason: string }
  | { kind: 'probe'; movie: string; etCodes: string; refEventCode?: string; language: string; date: string; bootstrap: boolean };

interface MovieState {
  /** Title as the per-venue data spells it */
  title: string;
  /** A known event code and a date it plays on (for the first, single-format request) */
  seed: { eventCode: string; date: string };
  /** language → reference event code for etCodes=* (empty until the first answer) */
  languages: Map<string, string>;
  /** event code → language */
  codeLanguage: Map<string, string>;
  /** language → dates the site offers in that language (unknown = probe every date) */
  languageDates: Map<string, Set<string>>;
}

export interface PlannerOptions {
  fullRefreshMs: number;
  priorityShare: number;
  /** Don't re-read a venue × date that was read less than this ago (by-movie data can be ~30 s old) */
  cooldownMs?: number;
  now?: () => number;
}

const probeKey = (movie: string, language: string, date: string) => `${movie}|${language}|${date}`;

export class ByMoviePlanner {
  private readonly movies = new Map<string, MovieState>();
  private readonly lastProbed = new Map<string, number>();
  /** `venue:date` → language → reason; any language pending means "read it" */
  private readonly pending = new Map<string, Map<string, string>>();
  private readonly lastRead = new Map<string, number>();
  private disabledUntil = 0;
  private priSent = 0;
  private restSent = 0;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: PlannerOptions) {
    this.cooldownMs = opts.cooldownMs ?? 90_000;
    this.now = opts.now ?? Date.now;
  }

  /** Learn which movies to follow from shows the watcher already knows (title + one event code each). */
  learn(shows: Iterable<{ movie: string; eventCode: string; date: string }>): void {
    for (const s of shows) {
      if (!s.movie || !s.eventCode || this.movies.has(s.movie)) continue;
      this.movies.set(s.movie, {
        title: s.movie,
        seed: { eventCode: s.eventCode, date: s.date },
        languages: new Map(),
        codeLanguage: new Map(),
        languageDates: new Map(),
      });
    }
  }

  get movieTitles(): string[] {
    return [...this.movies.keys()];
  }

  /** Stop planning (the caller falls back to plain rotation) until `ms` from now. */
  disable(ms: number): void {
    this.disabledUntil = this.now() + ms;
  }

  get disabled(): boolean {
    return this.now() < this.disabledUntil;
  }

  /** Record a full read of a venue × date (by whatever means). */
  read(venue: string, date: string, at = this.now()): void {
    this.lastRead.set(`${venue}:${date}`, at);
    this.pending.delete(`${venue}:${date}`);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  next(combos: Combo[]): PlannerAction | null {
    if (this.disabled || this.movies.size === 0) return null;
    const now = this.now();

    // 1. Changed venue × dates (priority ones first, then any), outside the cooldown.
    const changed = combos
      .filter((c) => this.pending.has(`${c.venue}:${c.date}`))
      .filter((c) => now - (this.lastRead.get(`${c.venue}:${c.date}`) ?? 0) >= this.cooldownMs)
      .sort((a, b) => Number(b.priority) - Number(a.priority));
    if (changed.length) {
      const c = changed[0]!;
      const reasons = [...this.pending.get(`${c.venue}:${c.date}`)!.values()];
      this.pending.delete(`${c.venue}:${c.date}`);
      return { kind: 'refresh', venue: c.venue, date: c.date, reason: reasons.join('; ') };
    }

    // 2. Safety net: anything not read in full for too long.
    const stale = combos
      .map((c) => ({ c, age: now - (this.lastRead.get(`${c.venue}:${c.date}`) ?? 0) }))
      .filter((x) => x.age >= this.opts.fullRefreshMs)
      .sort((a, b) => b.age - a.age)[0];
    if (stale) return { kind: 'refresh', venue: stale.c.venue, date: stale.c.date, reason: 'full refresh' };

    // 3. By-movie requests.
    const dates = [...new Set(combos.map((c) => c.date))];
    const priorityDates = new Set(combos.filter((c) => c.priority).map((c) => c.date));
    const probes: { action: PlannerAction & { kind: 'probe' }; priority: boolean; key: string }[] = [];
    for (const m of this.movies.values()) {
      if (m.languages.size === 0) {
        // Don't know the languages yet: one single-format request returns them.
        return { kind: 'probe', movie: m.title, etCodes: m.seed.eventCode, language: '', date: m.seed.date, bootstrap: true };
      }
      for (const [language, ref] of m.languages) {
        const offered = m.languageDates.get(language);
        for (const date of dates) {
          // A date the site doesn't offer in this language can't have shows; every answer in this
          // language carries the date list again, so an opening is noticed within one round.
          if (offered && offered.size && !offered.has(date)) continue;
          probes.push({
            action: { kind: 'probe', movie: m.title, etCodes: '*', refEventCode: ref, language, date, bootstrap: false },
            priority: priorityDates.has(date),
            key: probeKey(m.title, language, date),
          });
        }
      }
    }
    if (!probes.length) return null;
    const pri = probes.filter((p) => p.priority);
    const rest = probes.filter((p) => !p.priority);
    const usePri = pri.length > 0 && (rest.length === 0 || this.priSent < (this.priSent + this.restSent + 1) * this.opts.priorityShare);
    const group = usePri ? pri : rest;
    const pick = group.sort((a, b) => (this.lastProbed.get(a.key) ?? 0) - (this.lastProbed.get(b.key) ?? 0))[0]!;
    if (usePri) this.priSent++;
    else this.restSent++;
    this.lastProbed.set(pick.key, now);
    return pick.action;
  }

  /**
   * Take in a by-movie answer: learn languages, formats and dates, and mark
   * the venues whose snapshot disagrees. Returns what changed (for logging).
   */
  onProbe(
    action: PlannerAction & { kind: 'probe' },
    result: ByMovieResult,
    ctx: { venues: string[]; snapshots: Map<string, DateSnapshot | undefined> },
  ): { venue: string; reason: string }[] {
    const m = this.movies.get(action.movie);
    if (!m) return [];
    for (const l of result.languages) m.languages.set(l.language, l.refEventCode);
    for (const f of result.formats) m.codeLanguage.set(f.eventCode, f.language);
    if (action.bootstrap) {
      this.lastProbed.set(probeKey(m.title, '', m.seed.date), this.now());
      return []; // single format: not a complete picture of any venue
    }
    if (result.regionDates.length) m.languageDates.set(action.language, new Set(result.regionDates));

    const needs = venuesToRefresh({
      result,
      language: action.language,
      movieTitle: m.title,
      venues: ctx.venues,
      snapshots: ctx.snapshots,
      codeLanguage: m.codeLanguage,
    });
    const needed = new Set(needs.map((n) => n.venue));
    for (const v of ctx.venues) {
      const k = `${v}:${action.date}`;
      const langs = this.pending.get(k);
      if (needed.has(v)) {
        const reason = needs.find((n) => n.venue === v)!.reason;
        if (langs) langs.set(action.language, reason);
        else this.pending.set(k, new Map([[action.language, reason]]));
      } else if (langs) {
        // This language agrees now (e.g. the read already happened); drop just its reason.
        langs.delete(action.language);
        if (!langs.size) this.pending.delete(k);
      }
    }
    return needs;
  }
}
