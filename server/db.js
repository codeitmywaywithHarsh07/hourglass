/**
 * SQLite storage, built on Node's bundled `node:sqlite` so the project needs
 * no native database dependency.
 *
 * The extension this app replaces kept everything in chrome.storage.local,
 * including a 50-item array of already-notified event ids. That array could
 * evict ids during a busy stretch and re-notify. Here the ledger is a real
 * table keyed by (user_id, event_id), so a meeting can only ever fire once.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.DB_PATH || join(ROOT, "data", "app.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub    TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    name          TEXT,
    picture       TEXT,
    refresh_token TEXT,
    needs_reauth  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    lead_minutes  INTEGER NOT NULL DEFAULT 5,
    enabled       INTEGER NOT NULL DEFAULT 1,
    voice_enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notified (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id    TEXT NOT NULL,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_notified_at ON notified(notified_at);
`);

const now = () => Date.now();

/* ---------------------------------------------------------------- users -- */

export function upsertUser({ sub, email, name, picture, refreshToken }) {
  const existing = db
    .prepare("SELECT * FROM users WHERE google_sub = ?")
    .get(sub);

  if (existing) {
    // Google only returns a refresh token on the first consent (or when
    // prompt=consent is forced), so never clobber a stored one with null.
    db.prepare(
      `UPDATE users
          SET email = ?, name = ?, picture = ?,
              refresh_token = COALESCE(?, refresh_token),
              needs_reauth = 0
        WHERE id = ?`,
    ).run(email, name ?? null, picture ?? null, refreshToken ?? null, existing.id);
    return getUser(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO users (google_sub, email, name, picture, refresh_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sub, email, name ?? null, picture ?? null, refreshToken ?? null, now());

  const userId = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO settings (user_id, lead_minutes) VALUES (?, ?)",
  ).run(userId, Number(process.env.DEFAULT_LEAD_MINUTES || 5));

  return getUser(userId);
}

export function getUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function deleteUser(id) {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function markNeedsReauth(id) {
  db.prepare("UPDATE users SET needs_reauth = 1, refresh_token = NULL WHERE id = ?").run(id);
}

/** Users the scheduler should poll: enabled, still connected, with a device. */
export function listActiveUsers() {
  return db
    .prepare(
      `SELECT u.*, s.lead_minutes
         FROM users u
         JOIN settings s ON s.user_id = u.id
        WHERE s.enabled = 1
          AND u.needs_reauth = 0
          AND u.refresh_token IS NOT NULL
          AND EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.user_id = u.id)`,
    )
    .all();
}

/* ------------------------------------------------------------- settings -- */

export function getSettings(userId) {
  let row = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare("INSERT INTO settings (user_id, lead_minutes) VALUES (?, ?)").run(
      userId,
      Number(process.env.DEFAULT_LEAD_MINUTES || 5),
    );
    row = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(userId);
  }
  return {
    leadMinutes: row.lead_minutes,
    enabled: !!row.enabled,
    voiceEnabled: !!row.voice_enabled,
  };
}

export function updateSettings(userId, { leadMinutes, enabled, voiceEnabled }) {
  const current = getSettings(userId);
  const next = {
    leadMinutes: clampLead(leadMinutes ?? current.leadMinutes),
    enabled: enabled ?? current.enabled,
    voiceEnabled: voiceEnabled ?? current.voiceEnabled,
  };
  db.prepare(
    "UPDATE settings SET lead_minutes = ?, enabled = ?, voice_enabled = ? WHERE user_id = ?",
  ).run(next.leadMinutes, next.enabled ? 1 : 0, next.voiceEnabled ? 1 : 0, userId);
  return next;
}

function clampLead(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/* -------------------------------------------------------- subscriptions -- */

export function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  db.prepare(
    `INSERT INTO subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE
       SET user_id = excluded.user_id,
           p256dh  = excluded.p256dh,
           auth    = excluded.auth`,
  ).run(userId, endpoint, keys.p256dh, keys.auth, now());
}

export function listSubscriptions(userId) {
  return db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").all(userId);
}

export function deleteSubscription(endpoint) {
  db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(endpoint);
}

export function countSubscriptions(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?")
    .get(userId).n;
}

/* ------------------------------------------------------- notified ledger -- */

/** Returns true if this is the first time we've claimed this event. */
export function claimNotification(userId, eventId) {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO notified (user_id, event_id, notified_at)
       VALUES (?, ?, ?)`,
    )
    .run(userId, eventId, now());
  return info.changes > 0;
}

export function pruneNotified(maxAgeMs = 48 * 60 * 60 * 1000) {
  db.prepare("DELETE FROM notified WHERE notified_at < ?").run(now() - maxAgeMs);
}
