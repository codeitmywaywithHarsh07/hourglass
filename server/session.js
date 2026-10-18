/**
 * Stateless sessions: an HMAC-signed, httpOnly cookie holding the user id.
 * No session table, no session store — the signature is the whole mechanism.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE_NAME = "mpwa_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value === "replace-me") {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return value;
}

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Returns the signed-in user id, or null. */
export function readSession(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;

  const dot = raw.lastIndexOf(".");
  if (dot === -1) return null;

  const payload = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  const [userId, issuedAt] = payload.split(":");
  if (Date.now() - Number(issuedAt) > MAX_AGE_SECONDS * 1000) return null;

  const id = Number(userId);
  return Number.isInteger(id) ? id : null;
}

export function sessionCookie(userId) {
  const payload = `${userId}:${Date.now()}`;
  return cookie(`${payload}.${sign(payload)}`, MAX_AGE_SECONDS);
}

export function clearSessionCookie() {
  return cookie("", 0);
}

function cookie(value, maxAge) {
  const secure = (process.env.BASE_URL || "").startsWith("https://");
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * Signed, short-lived value used as the OAuth `state` parameter so the
 * callback can prove the redirect started here.
 */
export function createState() {
  const payload = `${randomBytes(12).toString("base64url")}:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state) {
  if (typeof state !== "string") return false;
  const dot = state.lastIndexOf(".");
  if (dot === -1) return false;

  const payload = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return false;
  }
  const issuedAt = Number(payload.split(":")[1]);
  return Date.now() - issuedAt < 10 * 60 * 1000;
}
