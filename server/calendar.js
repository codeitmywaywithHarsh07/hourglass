/**
 * Google Calendar access.
 *
 * The query and the meeting-link cascade are ported from the Chrome extension
 * (src/background.js and popup.js), with three fixes: pagination past the
 * first page, a forced token refresh and one retry on 401, and no 20-event
 * ceiling.
 */
import { getAccessToken, ReauthRequired } from "./auth.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** userId -> { fetchedAt, events } */
const cache = new Map();
const CACHE_TTL_MS = 45_000;

/**
 * Timed events from now until the end of tomorrow, local to the server.
 * All-day events have start.date instead of start.dateTime and are dropped —
 * there is no moment to count down to.
 */
export async function fetchEvents(user, { useCache = true } = {}) {
  if (useCache) {
    const hit = cache.get(user.id);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.events;
  }

  const now = new Date();
  const endOfTomorrow = new Date(now);
  endOfTomorrow.setDate(now.getDate() + 1);
  endOfTomorrow.setHours(23, 59, 59, 999);

  const raw = await listEvents(user, {
    timeMin: now.toISOString(),
    timeMax: endOfTomorrow.toISOString(),
  });

  const events = raw
    .filter((e) => e.start?.dateTime && e.status !== "cancelled")
    .map(normalizeEvent);

  cache.set(user.id, { fetchedAt: Date.now(), events });
  return events;
}

export function invalidateCache(userId) {
  cache.delete(userId);
}

async function listEvents(user, { timeMin, timeMax }) {
  const items = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true", // expand recurring events; required by orderBy
      orderBy: "startTime",
      maxResults: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await calendarRequest(
      user,
      `/calendars/primary/events?${params}`,
    );
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken && items.length < 250);

  return items;
}

async function calendarRequest(user, path, { retried = false } = {}) {
  const token = await getAccessToken(user, { force: retried });
  const res = await fetch(`${CALENDAR_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 && !retried) {
    // The cached access token went stale. Refresh once and try again — the
    // extension had no such handling, so a stale token silently killed polling.
    return calendarRequest(user, path, { retried: true });
  }

  if (res.status === 401 || res.status === 403) {
    const body = await res.text();
    throw new ReauthRequired(`Calendar API ${res.status}: ${body.slice(0, 200)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/** Trim a Google event down to what the UI and the push payload need. */
export function normalizeEvent(event) {
  const responseStatus = selfResponse(event);
  return {
    id: event.id,
    title: event.summary || "(no title)",
    start: event.start.dateTime,
    end: event.end?.dateTime ?? null,
    location: event.location || null,
    organizer: organizerName(event),
    description: plainText(event.description),
    joinUrl: getMeetingLink(event),
    attendees: Array.isArray(event.attendees) ? event.attendees.length : 0,
    htmlLink: event.htmlLink || null,
    responseStatus,
    declined: responseStatus === "declined",
  };
}

/**
 * The user's own RSVP, read from the attendee entry Google marks as `self`.
 *
 * Returns null when there is nothing to go on: a solo event with no attendee
 * list, an invitation that reached the user through a group alias so no entry
 * is theirs, or a large event whose attendee list Google truncated. In every
 * one of those cases the honest answer is "unknown", and callers treat unknown
 * as not-declined — a missed meeting is worse than one extra notification.
 */
export function selfResponse(event) {
  if (!Array.isArray(event.attendees)) return null;
  const me = event.attendees.find((a) => a.self);
  return me?.responseStatus ?? null;
}

function organizerName(event) {
  const o = event.organizer;
  if (!o) return null;
  if (o.displayName) return o.displayName;
  if (o.email) return o.email.split("@")[0].replace(/[._-]+/g, " ");
  return null;
}

function plainText(html) {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/**
 * Ported from popup.js getMeetingLink(): four tiers, most authoritative first.
 */
export function getMeetingLink(event) {
  if (event.hangoutLink) return event.hangoutLink;

  const video = event.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video",
  );
  if (video?.uri) return video.uri;

  if (event.location && /^https?:\/\//.test(event.location)) {
    return event.location.split(/\s+/)[0];
  }

  const urls = event.description?.match(/https?:\/\/[^\s<>"']+/g);
  if (urls) {
    const known = urls.find((url) =>
      /zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|chime\.aws/.test(
        url,
      ),
    );
    if (known) return known.replace(/[.,)]+$/, "");
  }

  return null;
}
