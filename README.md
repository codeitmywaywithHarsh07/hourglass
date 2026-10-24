# Hourglass

An installable PWA that pushes a notification a few minutes before every
Google Calendar meeting — **including when the app is closed**.

Live on Vercel; runs locally with one command.

---

## What it is

A rebuild of the `meeting-notifier` Chrome extension. The calendar query, the
four-tier meeting-link extraction and the notify-once-per-event rule are the
same logic; everything that depended on Chrome extension APIs was replaced:

| Extension | Hourglass |
| --- | --- |
| `chrome.identity` | Server-side Google OAuth with a stored refresh token |
| `chrome.alarms` polling in the browser | A cron-driven `/api/tick` that runs whether or not anything is open |
| `chrome.notifications` | Web Push (VAPID) → service worker `showNotification` |
| `chrome.storage.local` | Postgres |

A PWA service worker cannot reliably wake itself up to poll, which is why the
push has to originate server-side.

## Architecture

```
api/index.js        Vercel entry — exports the shared handler
server/
  app.js            routing; used by both entry points
  index.js          local dev: node:http server + in-process scheduler
  db.js             Postgres (pg): users, settings, subscriptions, notified
  session.js        HMAC-signed cookie, OAuth state
  auth.js           OAuth code flow, refresh, revoke
  calendar.js       event fetch (paginated, 401-retrying) + link extraction
  scheduler.js      tick(): the per-user check
  push.js           VAPID send, prunes dead subscriptions
public/             the PWA — index.html, styles.css, app.js, sw.js, icons
scripts/
  migrate.js        create the schema
  tick.js           run one scheduler pass by hand
  generate-vapid-keys.js
  generate-icons.js draws every icon from scratch, incl. favicon.ico
vercel.json         rewrites, cron, headers
```

Locally `server/index.js` runs a real HTTP server and ticks on a
`setInterval`. On Vercel there is no long-lived process: every request is a
fresh function, and an external cron calls `/api/tick`.

## Requirements

- Node 20.6+
- A Postgres database (Vercel Postgres, Neon, Supabase, or local)
- A Google Cloud project
- HTTPS in production (`localhost` is exempt)

---

## Local setup

### 1. Google Cloud

1. <https://console.cloud.google.com/> → create or pick a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **Google Auth Platform → Audience** (older console: *OAuth consent screen*):
   - **Internal** if everyone using it is in your Google Workspace org — no
     test-user list, no unverified-app warning.
   - Otherwise **External**, and add every user under **Test users** or they
     get `Error 403: access_denied`.
   - Scopes: `openid`, `email`, `profile`, `.../auth/calendar.readonly`.
4. **Credentials → Create credentials → OAuth client ID**
   - Type: **Web application** (a Chrome-extension client will not work).
   - JavaScript origin: `http://localhost:3000`
   - Redirect URI: `http://localhost:3000/auth/callback`

### 2. Configure

```bash
npm install
cp .env.example .env
npm run keys          # prints a VAPID keypair — paste both into .env
```

Fill in `.env`: `DATABASE_URL`, the Google client id/secret, the VAPID pair,
`VAPID_SUBJECT`, and random values for `SESSION_SECRET` and `CRON_SECRET`:

```bash
node -e "console.log(crypto.randomBytes(32).toString('hex'))"
```

For a local database:

```bash
createdb hourglass_dev
# DATABASE_URL=postgresql://$USER@localhost:5432/hourglass_dev
npm run migrate
```

### 3. Run

```bash
npm start
```

Open <http://localhost:3000>, connect Google, then enable **Push
notifications** in Settings.

---

## Deploying to Vercel

### 1. Create the project

Import the repo at <https://vercel.com/new>. Framework preset: **Other**.
`vercel.json` already sets the output directory, rewrites and function config,
so leave the build settings alone.

### 2. Attach a database

**Storage → Create Database → Postgres**, linked to the project. Vercel injects
`POSTGRES_URL`, which `server/db.js` picks up — no `DATABASE_URL` needed there.

The schema is applied lazily on first use, so a fresh database works
immediately. To do it explicitly instead, run the migration locally against the
production URL:

```bash
DATABASE_URL='<the POSTGRES_URL from Vercel>' node scripts/migrate.js
```

### 3. Environment variables

Settings → Environment Variables, scoped to **Production**:

| Name | Value |
| --- | --- |
| `BASE_URL` | `https://<your-project>.vercel.app` — exact, no trailing slash |
| `SESSION_SECRET` | a long random string |
| `GOOGLE_CLIENT_ID` | from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `VAPID_PUBLIC_KEY` | **same as local** |
| `VAPID_PRIVATE_KEY` | **same as local** |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `CRON_SECRET` | a long random string — `/api/tick` refuses to run without it in production |
| `DEFAULT_LEAD_MINUTES` | `5` |

`PORT` and `CHECK_INTERVAL_SECONDS` are local-only.

### 4. Point Google at the deployment

Add to the same OAuth client:

- JavaScript origin: `https://<your-project>.vercel.app`
- Redirect URI: `https://<your-project>.vercel.app/auth/callback`

### 5. Drive the tick

This is the part that makes closed-app notifications actually happen.

**Vercel Cron on Hobby only fires once per day**, which is useless here, so
`vercel.json` sets a daily schedule purely so deploys succeed, and the real
trigger is an external pinger:

1. Sign up at <https://cron-job.org> (free, supports 1-minute intervals).
2. Create a job for `https://<your-project>.vercel.app/api/tick`
3. Every **1 minute**
4. Add a request header `Authorization: Bearer <your CRON_SECRET>` — or, if the
   service can't set headers, use `/api/tick?key=<your CRON_SECRET>`

On **Pro**, delete the pinger and change `vercel.json` to:

```json
"crons": [{ "path": "/api/tick", "schedule": "* * * * *" }]
```

Vercel sends `Authorization: Bearer $CRON_SECRET` automatically.

A slower cadence still works — the dedupe ledger means nothing double-fires, and
an event inside the lead window is caught by whichever tick sees it first — but
alerts arrive late in proportion to the interval.

### 6. Re-enable notifications on the production domain

Push subscriptions are bound to an origin. The one you created on `localhost`
does **not** carry over. Open the deployed URL, sign in, and turn notifications
on again there.

---

## Installing it as an app

- **Desktop Chrome/Edge** — install icon in the address bar, or the ⤓ button in the header.
- **Android** — Chrome menu → *Install app*.
- **iPhone/iPad** — Safari → Share → **Add to Home Screen**. iOS only delivers
  web push to an installed PWA, on iOS 16.4+. Enable notifications from the
  Home Screen icon, not from Safari.

## How a notification happens

1. The cron calls `/api/tick` (authenticated with `CRON_SECRET`).
2. For each connected user with at least one registered device, it fetches
   today + tomorrow's timed events from the Calendar API.
3. Any event starting within the user's lead window (1–30 minutes, set in
   Settings) is claimed in the `notified` table. The insert *is* the lock, so a
   meeting can only fire once — even with overlapping ticks or a retry.
4. `push.js` sends the payload to every subscription via VAPID.
5. `sw.js` wakes up — with no page open — and calls `showNotification`.
   Tapping it opens the Meet/Zoom/Teams link directly.

## Settings

| Setting | Effect |
| --- | --- |
| Push notifications | Registers/removes this device and arms the scheduler |
| Alert me *n* minutes before | 1–30, per user |
| Voice announcements | Speaks the meeting aloud — only while the app is open, since `speechSynthesis` needs a live page |

## Launch animation

`index.html` opens with a splash that draws the app icon, then lets lime grains
fall and settle into the wordmark — about 1.6s. Its CSS is inline so it can't
flash unstyled, and its script is a classic inline one so the 4-second failsafe
exists even if `app.js` fails to load. Boot runs behind it.

| | |
| --- | --- |
| Installed PWA | full sequence |
| Browser tab | 400ms fade |
| `prefers-reduced-motion: reduce` | 400ms fade |
| `?splash=full` / `?splash=off` | force / skip |

## Icons

`npm run icons` redraws everything from code — there are no binary source
assets. Small sizes use a bolder cut of the mark (`BOLD` in that script),
because the full-size stroke weights disappear below about 48px.

## Tests

```bash
npm test
```

Runs on Node's built-in test runner — no framework, no dependencies. The
calendar and RSVP tests are pure and always run. The database-backed tests
(storage, and the real `tick()` driven against stubbed Google responses) skip
unless you point them at a database:

```bash
createdb hourglass_test
TEST_DATABASE_URL="postgresql://$USER@localhost:5432/hourglass_test" npm test
```

Two safeguards worth knowing about:

- These tests `TRUNCATE` tables, so `TEST_DATABASE_URL` is **refused** unless
  the database name contains `test`. Pointing it at your dev or production
  database fails loudly instead of wiping it.
- Files run serially (`--test-concurrency=1`). They share one database and each
  truncates it, so the runner's default parallelism makes them clobber each
  other.

`test/scheduler.test.js` is the one worth reading: it runs the real scheduler
with only the two outbound HTTP calls stubbed, and asserts on the `notified`
ledger — including that a declined meeting is never claimed, and still notifies
if the RSVP changes to yes while it is inside the lead window.

## Scripts

| | |
| --- | --- |
| `npm start` | local server + in-process scheduler |
| `npm run dev` | same, with `--watch` |
| `npm test` | the test suite (`npm run test:watch` to re-run on change) |
| `npm run migrate` | create/update the schema |
| `npm run tick` | run one scheduler pass by hand |
| `npm run keys` | generate a VAPID keypair |
| `npm run icons` | redraw all icons |

## Notes

- Only the **primary** calendar is read, read-only.
- All-day events are skipped — there is no start time to count down to.
- Disconnecting revokes the Google token and deletes the user, their devices
  and their ledger rows.
- Regenerating VAPID keys invalidates every existing subscription.

## License

MIT — see [LICENSE](LICENSE).
