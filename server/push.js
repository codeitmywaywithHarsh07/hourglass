/**
 * Web Push delivery. This is the piece that makes notifications work with the
 * app closed: the browser's push service holds the connection, so the OS wakes
 * the service worker even when no tab or window exists.
 */
import webpush from "web-push";
import { listSubscriptions, deleteSubscription } from "./db.js";

let configured = false;

export function configurePush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

  if (!publicKey || !privateKey) {
    console.warn(
      "[push] VAPID keys missing — notifications are disabled. Run `npm run keys`.",
    );
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function isConfigured() {
  return configured;
}

export function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Sends one payload to every device this user has registered.
 * A 404 or 410 means the subscription is dead (app uninstalled, permission
 * revoked, browser profile wiped) — drop it so it stops being retried.
 */
export async function sendToUser(userId, payload) {
  if (!configured) return { sent: 0, removed: 0 };

  const subs = await listSubscriptions(userId);
  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          { TTL: 600, urgency: "high" },
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await deleteSubscription(sub.endpoint);
          removed += 1;
        } else {
          console.error(`[push] send failed (${err.statusCode}):`, err.body || err.message);
        }
      }
    }),
  );

  return { sent, removed };
}
