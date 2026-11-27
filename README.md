# FDFS Radar

Watches Prasads Multiplex showtimes for the dates you care about and pings you on
Telegram when:

- a watched **date opens** for booking (one summary message),
- a **new show** (new SessionId) appears for a watched movie,
- a show goes from **not available → available** (`AvailStatus` 0 → 1).
- 🎯 a show gets **free seats in the middle of the hall** (see *Seat checks*;
  toggle with `seats.alertMiddle`).

Shows in a priority format (Infinity Vision, PCX, IMAX…) are prefixed with 🔥.
The first time a date is seen it is recorded as a **baseline** with no alerts.

Designed to run on your Mac at home (residential IP), not on a server.

## How it works

```
config.json ─┐
             ▼
 src/index.ts ── poll loop (60–90 s jitter, dates sequential)
     │
     ├─ src/sources/ticketing.ts   Playwright, persistent Chromium profile.
     │      opens the venue page once, then runs fetch() *inside* the page
     │      for each date → parseByVenue() → normalised Show[]
     │
     ├─ src/diff.ts                compares with Redis state, decides alerts
     │
     └─ src/notify/telegram.ts     formats + sends; state is committed to
                                   Redis only after Telegram accepts it
```

- **Bot check / non-JSON response:** one "blocked" Telegram alert, reload page,
  back off 5–10 min, then resume. A "recovered" message follows when it works again.
- **Cookie refresh:** the venue page is reloaded every 45 min.
- **Not open:** a date is "open" only if `ShowDetails[0].Date` equals the
  requested date (and, when present, `ShowDatesArray` lists it as enabled).
- **Venue down:** `Venues.isVenueDown` → logged, state untouched.

### Adding another source (prasadz.com, District, …)

Implement `ShowSource` from [src/sources/types.ts](src/sources/types.ts):
`init()`, `fetchDate(date) → DateSnapshot`, `recover()`, `bookingUrl(date)`,
`close()`. Redis keys are namespaced by `source` + `venue`, so sources never
collide. Wire it up in [src/index.ts](src/index.ts).

### Redis keys

| Key | Value |
| --- | --- |
| `fdfs:<source>:<venue>:show:<date>:<SessionId>` | `{movie, eventName, dimension, screen, attributes, time, availStatus}` |
| `fdfs:<source>:<venue>:open:<date>` | `1` / `0` |
| `fdfs:<source>:<venue>:baseline:<date>` | first-seen timestamp |
| `fdfs:<source>:<venue>:alerted:<kind>:<date>:<SessionId>` | dedupe marker (`avail` expires after 30 min so a real re-release can alert again) |

To re-baseline everything: `redis-cli --scan --pattern 'fdfs:*' | xargs redis-cli del`

## Setup

Requirements: Node 20+, Redis, PM2 (optional).

```bash
brew install redis && brew services start redis
npm install
npm run setup:browser          # downloads Playwright Chromium
cp .env.example .env           # fill in SITE_BASE_URL + Telegram values
npm run telegram:test          # should deliver a test message
```

**Telegram:** create a bot with [@BotFather](https://t.me/BotFather), send it any
message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy
`message.chat.id` into `TELEGRAM_CHAT_ID`.

### config.json

```jsonc
{
  "venueName": "Prasads Multiplex",       // shown in alerts
  "venue": "PRHN",
  "venueSlug": "prasads-multiplex-hyderabad",
  "region": "HYD",
  "dates": ["20261217", "2026-12-18"],    // YYYYMMDD or YYYY-MM-DD; past dates are skipped
  "movies": ["Avengers", "Dune"],         // case-insensitive keyword on the movie title; [] = all
  "priorityFormats": ["Infinity Vision", "PCX", "IMAX"],  // matched on Attributes or format
  "poll": { "minSeconds": 60, "maxSeconds": 90, "reloadEveryMinutes": 45,
            "blockedBackoffMinMinutes": 5, "blockedBackoffMaxMinutes": 10 }
}
```

Config is read at startup — restart after editing (`pm2 restart fdfs-radar`).

## Running

```bash
npm run once     # single round, good for checking everything works
npm run dev      # continuous, with tsx
```

The first run opens a visible Chromium window (`HEADLESS=false`). If a bot check
appears, solve it once in that window; the cookies are kept in `.browser-profile/`.
Headless mode is supported (`HEADLESS=true`) but is challenged far more often.
`BROWSER_CHANNEL=chrome` uses your installed Google Chrome instead.

### With PM2

```bash
npm i -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 logs fdfs-radar
pm2 save && pm2 startup        # start on login (follow the printed command)
```

## Seat checks ("middle of the theatre")

For watched shows that are bookable, the watcher also reads the seat map —
up to `seats.perRound` shows per round, each at most every
`seats.minIntervalMinutes`. The visual map is a canvas, so it uses the site's
own **accessibility seat selection** dialog (row-by-row seat lists) in a
second browser tab. It is read-only: it picks "1 ticket" to list seats and
never selects or holds one.

A show counts as **middle** when at least `seatsTogether` adjacent free seats
sit in a middle row *and* in the central part of that row:

| Setting | Default | Meaning |
| --- | --- | --- |
| `middle.rowsFrom` / `rowsTo` | `0.3` / `0.85` | depth band, 0 = front row (A, nearest the screen), 1 = back row |
| `middle.centerWidth` | `0.6` | central share of each row |
| `alertMiddle` | `true` | 🎯 Telegram alert when a watched show turns green (once per 30 min per show) |
| `middle.seatsTogether` | `1` | adjacent seats needed (set 2+ when booking for a group) |
| `screens["SCREEN 6"].rows` | `"A-N"` | full row range of a hall (`"A-H,J-N"` if a letter is skipped) |
| `screens[...].goodRows` | — | explicit list of rows you like; skips the depth band |

The site only lists rows that still have free seats, so for screens without a
`rows` entry the hall is **learned** (union of all rows seen, stored in
`fdfs:<source>:<venue>:layout:<SCREEN>`). The dashboard flags learned layouts;
add `rows` for any screen you know.

Results are stored in `fdfs:<source>:<venue>:seats:<date>:<SessionId>`.

## Dashboard

A local, read-only web UI at **http://127.0.0.1:4317** (localhost only):

- **Shows** — per date: open / not open, every showtime as a chip. **Green =
  free seats in the middle**, amber = only front/side seats, grey = sold out,
  dashed = bookable but not checked yet; 🔥 = priority format; NEW badge /
  flash when something changes. Click a chip for a mini seat map, counts,
  seat classes and the booking link.
- **Redis** — live key browser (`fdfs:*` by default, any pattern works) with
  type, TTL and value; click a row for pretty-printed JSON. Changed rows flash.
- **Alerts** — the last 200 alerts that were sent to Telegram.

Updates are pushed instantly: the watcher publishes on the Redis channel
`fdfs:events` after every poll and the dashboard streams that to the browser
(Server-Sent Events). PM2 runs it as `fdfs-dashboard`; standalone:
`npm run dashboard`. Port/host: `DASHBOARD_PORT`, `DASHBOARD_HOST`.

The watcher also keeps `fdfs:<source>:<venue>:snapshot:<date>` (full latest
response incl. seat classes), `fdfs:status` and `fdfs:alerts:log` for the UI.
Alerting never reads these.

### Keep the Mac awake

Alerts stop while the Mac sleeps. Either set *System Settings → Battery/Energy →
Prevent automatic sleeping when the display is off*, or run alongside:

```bash
caffeinate -dimsu &
```

## Tests

```bash
npm test          # parser + diff against fixtures/sample-20261217.json
npm run typecheck
```
