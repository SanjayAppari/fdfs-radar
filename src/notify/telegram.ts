import type { Alert, AlertShow } from '../diff.js';
import type { SeatSummary } from '../seats.js';
import { log } from '../log.js';
import { prettyDate, sleep } from '../time.js';

const MAX_LEN = 3900; // Telegram hard limit is 4096

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const statusLabel = (avail: string) =>
  avail === '1' ? '✅ Available' : avail === '0' ? '⛔ Not available yet' : `Status ${escapeHtml(avail)}`;

function screenLine(a: AlertShow): string {
  const { screen, attributes } = a.show;
  return [screen, attributes].filter(Boolean).map(escapeHtml).join(' · ') || '—';
}

function showBlock(title: string, a: AlertShow, link: string): string {
  const s = a.show;
  return [
    `${a.priority ? '🔥 ' : ''}<b>${title}</b>`,
    `🎬 <b>${escapeHtml(s.movie)}</b>`,
    `🎞 ${escapeHtml(s.eventName)}${s.dimension ? ` — <i>${escapeHtml(s.dimension)}</i>` : ''}`,
    `🖥 ${screenLine(a)}`,
    `📅 ${prettyDate(s.date)}  ⏰ ${escapeHtml(s.time)}`,
    `🎟 ${statusLabel(s.availStatus)}`,
    `🔗 <a href="${escapeHtml(link)}">Book now</a>`,
  ].join('\n');
}

export function formatAlert(alert: Alert, venueName: string, link: string): string {
  switch (alert.kind) {
    case 'new_show':
      return showBlock('NEW SHOW', alert.item, link);
    case 'avail_up':
      return showBlock('SEATS AVAILABLE', alert.item, link);
    case 'date_open': {
      const anyPriority = alert.shows.some((s) => s.priority);
      const head = `${anyPriority ? '🔥 ' : ''}<b>BOOKINGS OPEN</b> — ${escapeHtml(venueName)}\n📅 ${prettyDate(alert.date)}`;
      if (alert.shows.length === 0) {
        return `${head}\n\nNo watched movies listed yet.\n🔗 <a href="${escapeHtml(link)}">Open</a>`;
      }
      const byMovie = new Map<string, AlertShow[]>();
      for (const a of alert.shows) {
        const key = `${a.show.movie}|${a.show.eventName}`;
        byMovie.set(key, [...(byMovie.get(key) ?? []), a]);
      }
      const sections = [...byMovie.values()].map((items) => {
        const s0 = items[0]!.show;
        const lines = items.map(
          (a) =>
            `  ${a.priority ? '🔥' : '•'} ${escapeHtml(a.show.time)} · ${screenLine(a)} · ${a.show.availStatus === '1' ? '✅' : '⛔'}`,
        );
        return `🎬 <b>${escapeHtml(s0.movie)}</b>\n🎞 ${escapeHtml(s0.eventName)}${s0.dimension ? ` — <i>${escapeHtml(s0.dimension)}</i>` : ''}\n${lines.join('\n')}`;
      });
      return `${head}\n\n${sections.join('\n\n')}\n\n🔗 <a href="${escapeHtml(link)}">Book now</a>`;
    }
  }
}

/** 🎯 alert: a watched show now has free seats in the middle of the hall. */
export function formatMiddleSeats(a: AlertShow, seats: SeatSummary, link: string): string {
  const s = a.show;
  const rows = seats.rows
    .filter((r) => r.middleFree > 0)
    .map((r) => `${escapeHtml(r.row)}: ${r.middleFree}`)
    .join(', ');
  return [
    `${a.priority ? '🔥 ' : ''}🎯 <b>MIDDLE SEATS</b>`,
    `🎬 <b>${escapeHtml(s.movie)}</b>`,
    `🎞 ${escapeHtml(s.eventName)}${s.dimension ? ` — <i>${escapeHtml(s.dimension)}</i>` : ''}`,
    `🖥 ${screenLine(a)}`,
    `📅 ${prettyDate(s.date)}  ⏰ ${escapeHtml(s.time)}`,
    `💺 <b>${seats.middleFree}</b> middle free (best ${seats.bestBlock} together) · ${seats.totalFree} free in total`,
    rows ? `↕️ Rows ${rows}` : '',
    `🔗 <a href="${escapeHtml(link)}">Open seat map</a>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pack blocks into as few messages as possible under the size limit. */
export function packMessages(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of blocks) {
    const b = raw.length > MAX_LEN ? `${raw.slice(0, MAX_LEN - 20)}\n…(truncated)` : raw;
    if (cur && cur.length + 2 + b.length > MAX_LEN) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out;
}

export class TelegramNotifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  async send(text: string, attempt = 1): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });
    if (res.ok) return;

    const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = (body.parameters?.retry_after ?? 2 ** attempt) * 1000;
      log.warn(`telegram ${res.status}, retrying in ${wait}ms`);
      await sleep(wait);
      return this.send(text, attempt + 1);
    }
    throw new Error(`telegram sendMessage failed: HTTP ${res.status} ${body.description ?? ''}`);
  }

  async sendAll(texts: string[]): Promise<void> {
    for (const t of texts) await this.send(t);
  }
}
