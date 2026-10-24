import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, dbSkip, googleEvent, withSelf } from "./helpers.js";

/**
 * These drive the real tick() — db, auth, calendar and scheduler all run as
 * written. Only the two outbound HTTP calls are stubbed: the OAuth token
 * refresh and the Calendar list.
 *
 * Push is left unconfigured, so sendToUser is a no-op. That is deliberate: the
 * ledger is the observable contract, and a claimed row means a notification
 * was committed to.
 */
describe("scheduler tick", { skip: dbSkip }, () => {
  let db, tick, invalidateCache, user, calendarItems, realFetch;

  before(async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600 });
      }
      if (u.includes("googleapis.com/calendar/v3")) {
        return Response.json({ items: calendarItems });
      }
      throw new Error(`unexpected network call: ${u}`);
    };

    db = await freshDb();
    ({ tick } = await import("../server/scheduler.js"));
    ({ invalidateCache } = await import("../server/calendar.js"));
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await db.closePool();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE users RESTART IDENTITY CASCADE");
    user = await db.upsertUser({ sub: "u", email: "me@example.com", refreshToken: "rt" });
    await db.saveSubscription(user.id, {
      endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" },
    });
    calendarItems = [];
  });

  const notified = async () => {
    const { rows } = await db.query(
      "SELECT event_id FROM notified WHERE user_id=$1 ORDER BY event_id", [user.id]);
    return rows.map((r) => r.event_id);
  };

  const run = async () => { invalidateCache(user.id); await tick(); };

  const meeting = (id, minutes, attendees) =>
    googleEvent({ id, summary: id, startsInMinutes: minutes, attendees,
                  hangoutLink: "https://meet.google.com/x" });

  test("notifies for a meeting inside the lead window", async () => {
    calendarItems = [meeting("soon", 3, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), ["soon"]);
  });

  test("ignores a meeting beyond the lead window", async () => {
    calendarItems = [meeting("later", 45, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), []);
  });

  test("ignores a meeting that already started", async () => {
    calendarItems = [meeting("past", -10, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), []);
  });

  test("does not notify for a meeting you declined", async () => {
    calendarItems = [
      meeting("accepted-meeting", 3, withSelf("accepted")),
      meeting("declined-meeting", 3, withSelf("declined")),
    ];
    await run();
    assert.deepEqual(await notified(), ["accepted-meeting"]);
  });

  // The declined check sits before the ledger claim precisely so this works.
  test("a declined meeting notifies if the RSVP changes to yes in time", async () => {
    calendarItems = [meeting("changed-mind", 4, withSelf("declined"))];
    await run();
    assert.deepEqual(await notified(), [], "nothing claimed while declined");

    calendarItems = [meeting("changed-mind", 4, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), ["changed-mind"]);
  });

  test("a repeated tick never notifies twice", async () => {
    calendarItems = [meeting("once", 3, withSelf("accepted"))];
    await run();
    await run();
    await run();
    assert.deepEqual(await notified(), ["once"]);
  });

  test("all-day events are skipped — there is no moment to count down to", async () => {
    calendarItems = [{ id: "allday", summary: "Holiday", status: "confirmed", start: { date: "2026-10-24" } }];
    await run();
    assert.deepEqual(await notified(), []);
  });

  test("an event the organizer cancelled is skipped", async () => {
    calendarItems = [{ ...meeting("gone", 3, withSelf("accepted")), status: "cancelled" }];
    await run();
    assert.deepEqual(await notified(), []);
  });

  test("a user with no registered device is not polled", async () => {
    await db.query("DELETE FROM subscriptions WHERE user_id=$1", [user.id]);
    calendarItems = [meeting("nobody-listening", 3, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), []);
  });

  test("a user who switched notifications off is not polled", async () => {
    await db.updateSettings(user.id, { enabled: false });
    calendarItems = [meeting("muted", 3, withSelf("accepted"))];
    await run();
    assert.deepEqual(await notified(), []);
  });
});
