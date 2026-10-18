/**
 * The replacement for chrome.alarms.
 *
 * Every tick, for every connected user with at least one registered device:
 * read the calendar, find meetings starting inside their lead window, and push
 * once per meeting. Running server-side is what makes this survive the app
 * being closed, the laptop's browser being quit, or the phone being asleep.
 */
import { listActiveUsers, claimNotification, pruneNotified, markNeedsReauth } from "./db.js";
import { fetchEvents } from "./calendar.js";
import { sendToUser, isConfigured } from "./push.js";
import { ReauthRequired } from "./auth.js";

let timer = null;

export function startScheduler() {
  const seconds = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 60));

  if (!isConfigured()) {
    console.warn("[scheduler] not started: push is not configured");
    return;
  }

  const run = () => {
    tick().catch((err) => console.error("[scheduler] tick failed:", err));
  };

  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref?.();
  console.log(`[scheduler] checking every ${seconds}s`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick() {
  const users = await listActiveUsers();

  for (const user of users) {
    try {
      await checkUser(user);
    } catch (err) {
      if (err instanceof ReauthRequired) {
        console.warn(`[scheduler] ${user.email} needs to reconnect Google`);
        await markNeedsReauth(user.id);
      } else {
        console.error(`[scheduler] ${user.email}:`, err.message);
      }
    }
  }

  // Keep the dedupe ledger from growing forever. Cheap indexed delete, and
  // an in-process counter would not survive a serverless invocation anyway.
  await pruneNotified();
}

async function checkUser(user) {
  const events = await fetchEvents(user);
  const now = Date.now();
  const lead = user.lead_minutes ?? 5;

  for (const event of events) {
    const minutesUntil = Math.round((new Date(event.start).getTime() - now) / 60000);

    // Fire from `lead` minutes out until the moment it starts. Meetings that
    // already began are skipped: a late alert is noise, not a reminder.
    if (minutesUntil > lead || minutesUntil < 0) continue;

    // Atomic claim — the insert only succeeds the first time, so overlapping
    // ticks or a restart mid-window can never produce a duplicate.
    if (!(await claimNotification(user.id, event.id))) continue;

    const result = await sendToUser(user.id, buildPayload(event, minutesUntil));
    console.log(
      `[scheduler] ${user.email} -> "${event.title}" in ${minutesUntil}m ` +
        `(${result.sent} device${result.sent === 1 ? "" : "s"})`,
    );
  }
}

export function buildPayload(event, minutesUntil) {
  return {
    type: "meeting",
    eventId: event.id,
    title: event.title,
    start: event.start,
    minutesUntil,
    location: event.location,
    organizer: event.organizer,
    joinUrl: event.joinUrl,
  };
}
