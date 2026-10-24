import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, dbSkip } from "./helpers.js";

describe("storage", { skip: dbSkip }, () => {
  let db;
  before(async () => { db = await freshDb(); });
  after(async () => { await db.closePool(); });

  test("re-consent must not wipe a stored refresh token", async () => {
    const u = await db.upsertUser({ sub: "s1", email: "a@b.com", name: "A", refreshToken: "rt" });
    // Google omits the refresh token on a repeat consent.
    await db.upsertUser({ sub: "s1", email: "a@b.com", name: "A2", refreshToken: null });
    const row = await db.getUser(u.id);
    assert.equal(row.refresh_token, "rt");
    assert.equal(row.name, "A2", "other fields still update");
  });

  describe("notified ledger", () => {
    test("a meeting can only be claimed once", async () => {
      const u = await db.upsertUser({ sub: "led", email: "l@b.com", refreshToken: "rt" });
      assert.equal(await db.claimNotification(u.id, "e1"), true);
      assert.equal(await db.claimNotification(u.id, "e1"), false);
      assert.equal(await db.claimNotification(u.id, "e2"), true);
    });

    test("the ledger is per user", async () => {
      const a = await db.upsertUser({ sub: "pa", email: "pa@b.com", refreshToken: "rt" });
      const b = await db.upsertUser({ sub: "pb", email: "pb@b.com", refreshToken: "rt" });
      assert.equal(await db.claimNotification(a.id, "shared"), true);
      assert.equal(await db.claimNotification(b.id, "shared"), true);
    });

    // Overlapping ticks are possible now that the scheduler is cron-driven.
    test("exactly one winner among concurrent claims", async () => {
      const u = await db.upsertUser({ sub: "race", email: "r@b.com", refreshToken: "rt" });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => db.claimNotification(u.id, "same-event")),
      );
      assert.equal(results.filter(Boolean).length, 1);
    });

    test("stale rows are pruned", async () => {
      const u = await db.upsertUser({ sub: "prune", email: "p@b.com", refreshToken: "rt" });
      await db.claimNotification(u.id, "old");
      await db.query("UPDATE notified SET notified_at = $1 WHERE user_id = $2",
        [Date.now() - 72 * 3600 * 1000, u.id]);
      await db.pruneNotified();
      const { rows } = await db.query("SELECT COUNT(*)::int n FROM notified WHERE user_id=$1", [u.id]);
      assert.equal(rows[0].n, 0);
    });
  });

  describe("who the scheduler polls", () => {
    test("needs a device, an enabled setting and a live token", async () => {
      const u = await db.upsertUser({ sub: "elig", email: "e@b.com", refreshToken: "rt" });
      const mine = async () => (await db.listActiveUsers()).filter((r) => r.id === u.id).length;

      assert.equal(await mine(), 0, "no registered device yet");

      await db.saveSubscription(u.id, { endpoint: "https://push/e", keys: { p256dh: "p", auth: "a" } });
      assert.equal(await mine(), 1);

      await db.updateSettings(u.id, { enabled: false });
      assert.equal(await mine(), 0, "notifications switched off");

      await db.updateSettings(u.id, { enabled: true });
      await db.markNeedsReauth(u.id);
      assert.equal(await mine(), 0, "Google access revoked");
    });
  });

  describe("subscriptions", () => {
    test("re-subscribing the same endpoint updates rather than duplicates", async () => {
      const u = await db.upsertUser({ sub: "sub", email: "s@b.com", refreshToken: "rt" });
      await db.saveSubscription(u.id, { endpoint: "https://push/x", keys: { p256dh: "p1", auth: "a1" } });
      await db.saveSubscription(u.id, { endpoint: "https://push/x", keys: { p256dh: "p2", auth: "a2" } });
      assert.equal(await db.countSubscriptions(u.id), 1);
      const [row] = await db.listSubscriptions(u.id);
      assert.equal(row.p256dh, "p2", "keys are refreshed");
    });

    test("an incomplete subscription is rejected", async () => {
      const u = await db.upsertUser({ sub: "bad", email: "b@b.com", refreshToken: "rt" });
      await assert.rejects(() => db.saveSubscription(u.id, { endpoint: "https://push/y" }));
    });
  });

  describe("settings", () => {
    test("lead time is clamped to 1–60 minutes", async () => {
      const u = await db.upsertUser({ sub: "lead", email: "ld@b.com", refreshToken: "rt" });
      assert.equal((await db.updateSettings(u.id, { leadMinutes: 999 })).leadMinutes, 60);
      assert.equal((await db.updateSettings(u.id, { leadMinutes: 0 })).leadMinutes, 1);
      assert.equal((await db.updateSettings(u.id, { leadMinutes: "nonsense" })).leadMinutes, 5);
    });

    test("booleans round-trip", async () => {
      const u = await db.upsertUser({ sub: "bool", email: "bo@b.com", refreshToken: "rt" });
      await db.updateSettings(u.id, { voiceEnabled: false });
      assert.equal((await db.getSettings(u.id)).voiceEnabled, false);
    });
  });

  test("disconnecting a user removes their devices and ledger", async () => {
    const u = await db.upsertUser({ sub: "del", email: "d@b.com", refreshToken: "rt" });
    await db.saveSubscription(u.id, { endpoint: "https://push/d", keys: { p256dh: "p", auth: "a" } });
    await db.claimNotification(u.id, "e");
    await db.deleteUser(u.id);

    for (const table of ["subscriptions", "notified", "settings"]) {
      const { rows } = await db.query(`SELECT COUNT(*)::int n FROM ${table} WHERE user_id=$1`, [u.id]);
      assert.equal(rows[0].n, 0, `${table} should cascade`);
    }
  });
});
