# Hourglass

An installable PWA that pushes a notification a few minutes before every
Google Calendar meeting — **including when the app is closed**.

This is a rebuild of the `meeting-notifier` Chrome extension. The calendar
query, the four-tier meeting-link extraction and the notify-once-per-event
rule are the same logic; everything that depended on Chrome extension APIs was
replaced:

| Extension | Hourglass |
| --- | --- |
| `chrome.identity` | Server-side Google OAuth with a stored refresh token |
| `chrome.alarms` polling in the browser | A server scheduler that runs whether or not anything is open |
| `chrome.notifications` | Web Push (VAPID) → service worker `showNotification` |
| `chrome.storage.local` | SQLite |

A PWA service worker cannot reliably wake itself up to poll — that is why
there is a small Node server here rather than a pure static app.

---

## Requirements

- Node 22.5 or newer (uses the built-in `node:sqlite`)
- A Google Cloud project
- HTTPS in production (push and service workers require it; `localhost` is exempt)

## 1. Google Cloud setup

1. <https://console.cloud.google.com/> → create or pick a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External.
   - Add the scopes `openid`, `email`, `profile` and
     `.../auth/calendar.readonly`.
   - While the app is in *Testing*, every user must be added under
     **Test users** — otherwise their sign-in is rejected. Publish the app (or
     go through verification) to lift that.
4. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application** (the extension's client ID will not
     work here).
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/auth/callback`
   - Add your production origin and `https://your-domain/auth/callback` too.
5. Copy the client ID and secret.

## 2. Configure

```bash
npm install
cp .env.example .env
npm run keys          # prints a VAPID keypair — paste both into .env
```

Then fill in `.env`:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from step 1
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` from `npm run keys`
- `VAPID_SUBJECT` — your `mailto:` address
- `SESSION_SECRET` — any long random string:
  `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`
- `BASE_URL` — must exactly match the origin you open in the browser

## 3. Run

```bash
npm start
```

Open <http://localhost:3000>, connect Google, then turn **Push notifications**
on in Settings and allow the browser prompt.

## Installing it as an app

- **Desktop Chrome/Edge** — install icon in the address bar, or the ⤓ button in
  the app's header.
- **Android** — Chrome menu → *Install app* / *Add to Home screen*.
- **iPhone/iPad** — Safari → Share → **Add to Home Screen**. iOS only delivers
  web push to an installed PWA, on iOS 16.4+. Open it from the Home Screen icon
  and enable notifications there.

## How a notification happens

1. `server/scheduler.js` ticks every `CHECK_INTERVAL_SECONDS` (default 60).
2. For each connected user with at least one registered device, it fetches
   today + tomorrow's timed events from the Calendar API.
3. Any event starting within the user's lead window (1–30 minutes, set in
   Settings) is claimed in the `notified` table. The insert is the lock, so a
   meeting can only ever fire once — even across restarts or overlapping ticks.
4. `server/push.js` sends the payload to every subscription via VAPID.
5. `public/sw.js` wakes up — with no page open — and calls `showNotification`.
   Tapping it opens the Meet/Zoom/Teams link directly.

## Settings

| Setting | Effect |
| --- | --- |
| Push notifications | Registers/removes this device and arms the scheduler |
| Alert me *n* minutes before | 1–30, per user |
| Voice announcements | Speaks the meeting aloud — only while the app is open, since `speechSynthesis` needs a live page |

## Layout

```
server/
  index.js      node:http routing + static files
  db.js         SQLite: users, settings, subscriptions, notified ledger
  session.js    HMAC-signed cookie, OAuth state
  auth.js       OAuth code flow, refresh, revoke
  calendar.js   event fetch (paginated, 401-retrying) + link extraction
  push.js       VAPID send, prunes dead subscriptions
  scheduler.js  the every-minute check
public/
  index.html styles.css app.js    the UI (index.html also carries the splash)
  sw.js                           push handler + offline shell
  manifest.webmanifest
  favicon.ico favicon.svg
  icons/                          app, maskable, apple-touch, badge, favicon PNGs
scripts/
  generate-vapid-keys.js
  generate-icons.js               draws every icon from scratch, incl. favicon.ico
```

## Launch animation

`index.html` opens with a splash that draws the app icon — ring, sweeping
hands, alert dot — then lets lime grains fall and settle into the wordmark,
about 1.6s in total. It is styled and driven entirely from inside
`index.html`: the CSS is inline so it can't flash unstyled while `styles.css`
is still in flight, and the script is a classic inline one (not a module) so
its 4-second failsafe exists even if `app.js` fails to load.

Boot runs *behind* it — `init()` in `app.js` races the splash against
`registerServiceWorker()` + `loadMe()` and dismisses on whichever finishes
last, so the animation covers the calendar fetch instead of delaying it.

| | |
| --- | --- |
| Installed PWA | full sequence |
| Browser tab | 400ms fade (so reloads while developing aren't slowed) |
| `prefers-reduced-motion: reduce` | 400ms fade |
| `?splash=full` | forces the full sequence in a plain tab — handy for demos |
| `?splash=off` | skips it entirely |
| Click / tap / Escape | skips ahead immediately |

## Icons

`npm run icons` (or `node scripts/generate-icons.js`) redraws everything from
code — there are no binary source assets. It emits the 192/512 app icons, the
maskable variant, the Apple touch icon, the Android notification badge, the
16/32 favicon PNGs and a real multi-image `favicon.ico`. `favicon.svg` is
hand-written to the same geometry so it stays crisp on hi-dpi tabs.

Small sizes use a deliberately bolder cut of the mark (`BOLD` in that script) —
the full-size stroke weights disappear below about 48px.

## Deploying

Any host that can run a long-lived Node process works (Fly, Railway, Render, a
VPS). Serverless needs an external cron hitting a tick endpoint, since the
scheduler is an in-process interval.

- Serve over HTTPS and set `BASE_URL` to that origin.
- Add `https://your-domain/auth/callback` to the OAuth client.
- `data/app.db` holds refresh tokens — put it on a persistent volume and keep
  it private.
- Regenerating VAPID keys invalidates every existing subscription; devices have
  to re-enable notifications.

## Notes

- Only the **primary** calendar is read, read-only.
- All-day events are skipped — there is no start time to count down to.
- Disconnecting revokes the Google token and deletes the user, their devices
  and their ledger rows from the server.
