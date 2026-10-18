/**
 * Google OAuth 2.0, authorization-code flow with offline access.
 *
 * The extension used chrome.identity, which hands out an access token tied to
 * the signed-in Chrome profile and refreshes it invisibly. A PWA has no such
 * broker, and more importantly the scheduler has to read the calendar while
 * nobody is signed in on any device — so the server holds a refresh token and
 * mints access tokens itself.
 */
import { upsertUser, markNeedsReauth } from "./db.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** userId -> { token, expiresAt } */
const accessTokenCache = new Map();

export function redirectUri() {
  return `${baseUrl()}/auth/callback`;
}

function baseUrl() {
  return (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function clientId() {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
  return id;
}

function clientSecret() {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return secret;
}

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Without this Google skips the consent screen on a repeat sign-in and
    // returns no refresh token, which would leave the scheduler unable to
    // read that user's calendar.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Exchanges the callback code for tokens and upserts the user. */
export async function exchangeCode(code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error}`);
  }

  const profile = decodeIdToken(data.id_token);
  if (!profile?.sub) throw new Error("Google did not return an id_token");

  const user = upsertUser({
    sub: profile.sub,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    refreshToken: data.refresh_token ?? null,
  });

  if (data.access_token) {
    accessTokenCache.set(user.id, {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
    });
  }

  return user;
}

/**
 * A valid access token for this user, refreshing when the cached one is
 * missing or about to expire. Pass force to bypass the cache after a 401.
 */
export async function getAccessToken(user, { force = false } = {}) {
  if (!force) {
    const cached = accessTokenCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
  }

  if (!user.refresh_token) {
    markNeedsReauth(user.id);
    throw new ReauthRequired("No refresh token stored");
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: user.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    // invalid_grant = the user revoked access or the token expired for good.
    if (data.error === "invalid_grant") {
      accessTokenCache.delete(user.id);
      markNeedsReauth(user.id);
      throw new ReauthRequired(data.error_description || "invalid_grant");
    }
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }

  accessTokenCache.set(user.id, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  });
  return data.access_token;
}

export function forgetAccessToken(userId) {
  accessTokenCache.delete(userId);
}

/** Best-effort revoke so "Disconnect" actually detaches the Google account. */
export async function revoke(refreshToken) {
  if (!refreshToken) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    /* revoking is a courtesy; losing the local token is what matters */
  }
}

export class ReauthRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "ReauthRequired";
  }
}

/**
 * The id_token arrives over TLS directly from Google's token endpoint in
 * exchange for our client secret, so the payload is read without verifying
 * the signature (per Google's own guidance for the code flow).
 */
function decodeIdToken(idToken) {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
