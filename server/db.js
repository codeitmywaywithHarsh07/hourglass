/**
 * Postgres storage.
 *
 * This was SQLite (node:sqlite) while the app ran as a long-lived process.
 * On Vercel every request is a fresh, short-lived function with an ephemeral
 * filesystem, so a file-backed database would lose refresh tokens and push
 * subscriptions constantly. Everything here is therefore async.
 *
 * `pg` rather than @vercel/postgres so the same code works against Vercel
 * Postgres, Neon, Supabase or a plain local Postgres.
 */
import pg from "pg";

const { Pool } = pg;

const isLoopback = (url) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

/**
 * Candidates in preference order. DATABASE_URL wins so you can point a
 * deployment at any Postgres, but copying a whole local .env into a hosting
 * provider is a very easy mistake — and a loopback address can never be right
 * once deployed, so it is skipped there in favour of the platform's own
 * variable rather than failing with a bare ECONNREFUSED.
 */
function pickConnection() {
  const deployed = !!process.env.VERCEL;
  const candidates = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["POSTGRES_URL", process.env.POSTGRES_URL],
    ["POSTGRES_PRISMA_URL", process.env.POSTGRES_PRISMA_URL],
  ].filter(([, v]) => v);

  if (!candidates.length) {
    throw new Error(
      "No database connection string. Set DATABASE_URL (or attach a Postgres store so POSTGRES_URL is injected).",
    );
  }

  const usable = deployed ? candidates.filter(([, v]) => !isLoopback(v)) : candidates;

  if (!usable.length) {
    const names = candidates.map(([n]) => n).join(", ");
    const verb = candidates.length === 1 ? "points" : "point";
    throw new Error(
      `${names} ${verb} at localhost, which cannot work on a deployed server. ` +
        "Remove the local value and attach a Postgres database, or set " +
        "DATABASE_URL to its connection string.",
    );
  }

  const [name, url] = usable[0];
  if (deployed && usable.length < candidates.length) {
    console.warn(`[db] ignoring a localhost connection string; using ${name}`);
  }
  return url;
}

const CONNECTION = pickConnection();
const isLocal = isLoopback(CONNECTION);

// One connection per warm function instance. Hosted Postgres sits behind a
// pooler, so a wide pool per instance would exhaust it as instances multiply.
const pool = new Pool({
  connectionString: CONNECTION,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function closePool() {
  await pool.end();
}

/* ----------------------------------------------------------------- schema -- */

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    google_sub    TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    name          TEXT,
    picture       TEXT,
    refresh_token TEXT,
    needs_reauth  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lead_minutes  INTEGER NOT NULL DEFAULT 5,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    voice_enabled BOOLEAN NOT NULL DEFAULT TRUE
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notified (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id    TEXT NOT NULL,
    notified_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_notified_at ON notified(notified_at);
`;

export function migrate() {
  return query(SCHEMA);
}

/**
 * Applied lazily, once per instance. `npm run migrate` is the deliberate path;
 * this just means a fresh deployment against an empty database still works
 * instead of 500ing on the first request.
 */
let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = migrate().catch((err) => {
      ready = null; // let the next request retry rather than wedging forever
      throw err;
    });
  }
  return ready;
}

async function sql(text, params) {
  await ensureSchema();
  return query(text, params);
}

const now = () => Date.now();

/* ---------------------------------------------------------------- users -- */

export async function upsertUser({ sub, email, name, picture, refreshToken }) {
  // Google only returns a refresh token on first consent (or when
  // prompt=consent forces it), so COALESCE keeps a stored one.
  const { rows } = await sql(
    `INSERT INTO users (google_sub, email, name, picture, refresh_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (google_sub) DO UPDATE
       SET email         = EXCLUDED.email,
           name          = EXCLUDED.name,
           picture       = EXCLUDED.picture,
           refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
           needs_reauth  = FALSE
     RETURNING *`,
    [sub, email, name ?? null, picture ?? null, refreshToken ?? null, now()],
  );

  const user = rows[0];
  await sql(
    `INSERT INTO settings (user_id, lead_minutes)
     VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [user.id, Number(process.env.DEFAULT_LEAD_MINUTES || 5)],
  );
  return user;
}

export async function getUser(id) {
  const { rows } = await sql("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function deleteUser(id) {
  await sql("DELETE FROM users WHERE id = $1", [id]);
}

export async function markNeedsReauth(id) {
  await sql(
    "UPDATE users SET needs_reauth = TRUE, refresh_token = NULL WHERE id = $1",
    [id],
  );
}

/** Users the scheduler should poll: enabled, still connected, with a device. */
export async function listActiveUsers() {
  const { rows } = await sql(
    `SELECT u.*, s.lead_minutes
       FROM users u
       JOIN settings s ON s.user_id = u.id
      WHERE s.enabled
        AND NOT u.needs_reauth
        AND u.refresh_token IS NOT NULL
        AND EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.user_id = u.id)`,
  );
  return rows;
}

/* ------------------------------------------------------------- settings -- */

export async function getSettings(userId) {
  let { rows } = await sql("SELECT * FROM settings WHERE user_id = $1", [userId]);

  if (!rows[0]) {
    await sql(
      "INSERT INTO settings (user_id, lead_minutes) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [userId, Number(process.env.DEFAULT_LEAD_MINUTES || 5)],
    );
    ({ rows } = await sql("SELECT * FROM settings WHERE user_id = $1", [userId]));
  }

  return {
    leadMinutes: rows[0].lead_minutes,
    enabled: rows[0].enabled,
    voiceEnabled: rows[0].voice_enabled,
  };
}

export async function updateSettings(userId, { leadMinutes, enabled, voiceEnabled }) {
  const current = await getSettings(userId);
  const next = {
    leadMinutes: clampLead(leadMinutes ?? current.leadMinutes),
    enabled: enabled ?? current.enabled,
    voiceEnabled: voiceEnabled ?? current.voiceEnabled,
  };
  await sql(
    "UPDATE settings SET lead_minutes = $1, enabled = $2, voice_enabled = $3 WHERE user_id = $4",
    [next.leadMinutes, next.enabled, next.voiceEnabled, userId],
  );
  return next;
}

function clampLead(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/* -------------------------------------------------------- subscriptions -- */

export async function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  await sql(
    `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh  = EXCLUDED.p256dh,
           auth    = EXCLUDED.auth`,
    [userId, endpoint, keys.p256dh, keys.auth, now()],
  );
}

export async function listSubscriptions(userId) {
  const { rows } = await sql("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
  return rows;
}

export async function deleteSubscription(endpoint) {
  await sql("DELETE FROM subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function countSubscriptions(userId) {
  const { rows } = await sql(
    "SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1",
    [userId],
  );
  return rows[0].n;
}

/* ------------------------------------------------------- notified ledger -- */

/** True only the first time this event is claimed — the insert is the lock. */
export async function claimNotification(userId, eventId) {
  const res = await sql(
    `INSERT INTO notified (user_id, event_id, notified_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    [userId, eventId, now()],
  );
  return res.rowCount > 0;
}

export async function pruneNotified(maxAgeMs = 48 * 60 * 60 * 1000) {
  await sql("DELETE FROM notified WHERE notified_at < $1", [now() - maxAgeMs]);
}
