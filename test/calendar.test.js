import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { googleEvent, withSelf } from "./helpers.js";
import { getMeetingLink, normalizeEvent, selfResponse } from "../server/calendar.js";

describe("getMeetingLink — four tiers, most authoritative first", () => {
  test("hangoutLink wins outright", () => {
    assert.equal(
      getMeetingLink({
        hangoutLink: "https://meet.google.com/win",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/lose" }] },
      }),
      "https://meet.google.com/win",
    );
  });

  test("falls back to the video conference entry point, ignoring phone", () => {
    assert.equal(
      getMeetingLink({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1" },
            { entryPointType: "video", uri: "https://meet.google.com/bbb" },
          ],
        },
      }),
      "https://meet.google.com/bbb",
    );
  });

  test("uses a URL in location, trimming trailing prose", () => {
    assert.equal(
      getMeetingLink({ location: "https://us02web.zoom.us/j/123 (passcode 9)" }),
      "https://us02web.zoom.us/j/123",
    );
  });

  test("scans the description for a known provider, skipping other links", () => {
    assert.equal(
      getMeetingLink({ description: "agenda https://example.com/doc join https://teams.microsoft.com/l/x." }),
      "https://teams.microsoft.com/l/x",
    );
  });

  test("a physical location is not a link", () => {
    assert.equal(getMeetingLink({ location: "Olive Room, 4th floor" }), null);
  });

  test("nothing to find", () => {
    assert.equal(getMeetingLink({}), null);
  });
});

describe("normalizeEvent", () => {
  test("strips HTML and decodes entities in the description", () => {
    const e = normalizeEvent(googleEvent({
      description: "<p>Bring <b>numbers</b> &amp; slides</p>",
    }));
    assert.equal(e.description, "Bring numbers & slides");
  });

  test("derives a readable organizer name from an email", () => {
    const e = normalizeEvent(googleEvent({ organizer: { email: "priya.nair@corp.com" } }));
    assert.equal(e.organizer, "priya nair");
  });

  test("prefers the organizer's display name", () => {
    const e = normalizeEvent(googleEvent({ organizer: { displayName: "Platform team", email: "p@x" } }));
    assert.equal(e.organizer, "Platform team");
  });

  test("counts attendees", () => {
    assert.equal(normalizeEvent(googleEvent({ attendees: [{}, {}, {}] })).attendees, 3);
  });

  test("exposes the full contract the client and push payload rely on", () => {
    const e = normalizeEvent(googleEvent());
    for (const key of [
      "id", "title", "start", "end", "location", "organizer",
      "description", "joinUrl", "attendees", "htmlLink",
      "responseStatus", "declined",
    ]) {
      assert.ok(key in e, `missing field: ${key}`);
    }
  });
});

describe("selfResponse — whose RSVP is it", () => {
  const cases = [
    ["declined",                 withSelf("declined"),    "declined", true],
    ["accepted",                 withSelf("accepted"),    "accepted", false],
    ["tentative",                withSelf("tentative"),   "tentative", false],
    ["not answered yet",         withSelf("needsAction"), "needsAction", false],
  ];

  for (const [label, attendees, status, declined] of cases) {
    test(`self ${label}`, () => {
      const e = normalizeEvent(googleEvent({ attendees }));
      assert.equal(e.responseStatus, status);
      assert.equal(e.declined, declined);
    });
  }

  test("someone else declining is not me declining", () => {
    const e = normalizeEvent(googleEvent({
      attendees: withSelf("accepted", [{ email: "other@x", responseStatus: "declined" }]),
    }));
    assert.equal(e.declined, false);
  });

  test("an organizer who declined their own meeting still counts as declined", () => {
    const e = normalizeEvent(googleEvent({
      attendees: [{ email: "me@example.com", self: true, organizer: true, responseStatus: "declined" }],
    }));
    assert.equal(e.declined, true);
  });

  // Unknown must mean "notify". A missed meeting is worse than a spare alert.
  test("a solo event with no attendee list is not declined", () => {
    assert.equal(normalizeEvent(googleEvent()).declined, false);
    assert.equal(selfResponse({}), null);
  });

  test("an invite via a group alias, with no entry of mine, is not declined", () => {
    const e = normalizeEvent(googleEvent({
      attendees: [{ email: "team@x", responseStatus: "declined" }],
    }));
    assert.equal(e.declined, false);
    assert.equal(e.responseStatus, null);
  });

  test("a self entry carrying no responseStatus is not declined", () => {
    const e = normalizeEvent(googleEvent({ attendees: [{ email: "me@example.com", self: true }] }));
    assert.equal(e.declined, false);
  });

  test("an empty attendee list is not declined", () => {
    assert.equal(selfResponse({ attendees: [] }), null);
  });
});
