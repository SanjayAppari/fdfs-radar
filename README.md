# FDFS Radar

Watches showtimes at your chosen Hyderabad cinemas (Prasads Multiplex, AMB
Cinemas, ALLU Cinemas, …) for the dates you care about and pings you on
Telegram when:

- a watched **date opens** for booking (one summary message),
- a **new show** (new SessionId) appears for a watched movie — tagged 🆕 when
  it's on a screen or in a format that movie didn't have that day,
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
  "region": "HYD",
  "venues": [
    {
      "name": "Prasads Multiplex",              // shown in alerts and the dashboard
      "code": "PRHN",                           // from the venue page link …/buytickets/<CODE>/<date>
      "slug": "prasads-multiplex-hyderabad",    // from the venue page link …/cinemas/<city>/<slug>/…
      "screens": { "SCREEN 6": { "rows": "A-N" }, "SCREEN 4": { "rows": "N-A" } }
    },
    { "name": "AMB Cinemas", "code": "AMBH", "slug": "amb-cinemas-gachibowli",
      "dates": ["20261219"], "movies": ["Dune"] }   // optional per-venue overrides
  ],
  "dates": ["20261217", "2026-12-18"],    // YYYYMMDD or YYYY-MM-DD; past dates are skipped
  "movies": ["Avengers", "Dune"],         // case-insensitive keyword on the movie title; [] = all
  "priorityFormats": ["Infinity Vision", "PCX", "IMAX"],  // matched on Attributes or format
  "poll": { "minSeconds": 60, "maxSeconds": 90, "reloadEveryMinutes": 45,
            "blockedBackoffMinMinutes": 5, "blockedBackoffMaxMinutes": 10 },
  "seats": { "enabled": true, "alertMiddle": true, "perRound": 3, "minIntervalMinutes": 5,
             "middle": { "rowsFrom": 0.3, "rowsTo": 0.85, "centerWidth": 0.6, "seatsTogether": 1 } }
}
```

Each round polls every date at every venue that watches it (date by date,
2–5 s apart), then reads a few seat maps, then pauses 60–90 s. More venues ×
dates means longer rounds — trim per-venue `dates` if a venue only matters
for some days. The old single-venue format (`venue`, `venueSlug`,
`venueName`, `seats.screens`) still loads.

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
| `alertMiddle` | `true` | 🎯 Telegram alert when a watched show turns green |
| `middle.seatsTogether` | `1` | adjacent seats needed (set 2+ when booking for a group) |
| `venues[].screens["SCREEN 6"].rows` | — | rows **from the screen to the back**: `"A-N"` (A at the screen) or `"N-A"` (N at the screen); `"A-H,J-N"` if a letter is skipped |
| `venues[].screens[...].goodRows` | — | explicit list of rows you like; skips the depth band |

#### Fast loop (rows released and refilled within seconds)

A second loop, in its own browser tab, keeps re-reading a few **hot** shows —
by default the 4 watched, bookable shows in priority formats on the earliest
dates — about every `intervalSeconds` (20 s). The 🎯 alert goes out as soon as
a change is seen. Hot shows are marked ⚡ on the dashboard and skipped by the
regular seat checks. Pick exactly which shows are hot with filters:

```jsonc
"fast": { "enabled": true, "maxShows": 4, "intervalSeconds": 20,
          "venues": ["ALUC"], "dates": ["20261218"], "formats": ["Infinity Vision"] }
```

More hot shows or a shorter interval = more requests from your connection and
a higher chance of a Cloudflare challenge (both loops pause together on a block).

| Alert setting | Default | Meaning |
| --- | --- | --- |
| `alertRowsOpened` | `true` | 🔓 alert when a row with no free seats at the last check now has some (any row, middle or not) |
| `rowUnlockMinSeats` | `1` | minimum free seats in a newly opened row to alert (raise to ignore single cancellations) |
| `alertIncrease` | `4` | also alert when an already-green show gains this many middle seats (a row was released); `0` = off |
| `alertCooldownMinutes` | `10` | repeat 🎯 alerts for the same show at most this often |

The site only lists rows that still have free seats, so for screens without a
`rows` entry the hall is **learned** (union of all rows seen, stored in
`fdfs:<source>:<venue>:layout:<SCREEN>`). The dashboard flags learned layouts;
add `rows` for any screen you know.

Results are stored in `fdfs:<source>:<venue>:seats:<date>:<SessionId>`.

### Hall templates (exact seat-map drawing)

`layouts.json` holds every screen's real geometry — which column each seat
sits in, aisles, and gap rows — so the dashboard draws seat maps exactly like
the site. It was captured from the site's own seat maps for all 18 screens.
Re-capture after a hall changes or when adding a venue (uses its own browser
profile, safe to run alongside the watcher):

```bash
npm run capture-layouts                     # every screen at every venue
npm run capture-layouts -- AMBH "SCREEN 2"  # one screen
```

Each screen needs `rows` (and ideally `leftToRight`) in `config.json` first.
Wide halls are captured by zooming out and panning across the map.

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
