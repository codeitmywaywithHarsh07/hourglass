/**
 * The request handler, independent of how it is served.
 *
 * Locally `server/index.js` wraps this in a node:http server; on Vercel
 * `api/index.js` exports it directly as a serverless function. Keeping the
 * routing in one place means local and production behave identically.
 */
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

import {
  getUser,
  deleteUser,
  getSettings,
  updateSettings,
  saveSubscription,
  deleteSubscription,
  countSubscriptions,
} from "./db.js";
import {
  authorizeUrl,
  exchangeCode,
  revoke,
  forgetAccessToken,
  ReauthRequired,
} from "./auth.js";
import { fetchEvents, invalidateCache } from "./calendar.js";
import { configurePush, publicKey, sendToUser, isConfigured } from "./push.js";
import { tick } from "./scheduler.js";
import {
  readSession,
  sessionCookie,
  clearSessionCookie,
  createState,
  verifyState,
} from "./session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Cold-start work. Safe to repeat; cheap when the instance is warm.
configurePush();

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (path === "/auth/google") return authStart(req, res);
    if (path === "/auth/callback") return await authCallback(req, res, url);
    if (path === "/auth/signout") return signOut(req, res);

    if (path.startsWith("/api/")) return await api(req, res, url, path);

    // On Vercel the platform serves public/ before the function is reached;
    // this branch is what makes `npm start` work locally.
    return await serveStatic(res, path);
  } catch (err) {
    console.error(`[server] ${req.method} ${path}:`, err);
    send(res, 500, { error: "Internal error" });
  }
}

/* ------------------------------------------------------------------ auth -- */

function authStart(req, res) {
  try {
    res.writeHead(302, { Location: authorizeUrl(createState()) });
    res.end();
  } catch (err) {
    redirect(res, `/?error=${encodeURIComponent(err.message)}`);
  }
}

async function authCallback(req, res, url) {
  const error = url.searchParams.get("error");
  if (error) return redirect(res, `/?error=${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !verifyState(state)) return redirect(res, "/?error=invalid_state");

  try {
    const user = await exchangeCode(code);
    res.writeHead(302, { Location: "/", "Set-Cookie": sessionCookie(user.id) });
    res.end();
  } catch (err) {
    console.error("[auth] callback failed:", err.message);
    redirect(res, `/?error=${encodeURIComponent(err.message)}`);
  }
}

function signOut(req, res) {
  res.writeHead(302, { Location: "/", "Set-Cookie": clearSessionCookie() });
  res.end();
}

/* ------------------------------------------------------------------- api -- */

async function api(req, res, url, path) {
  // The scheduler's replacement: an external cron calls this every minute.
  if (path === "/api/tick") return await runTick(req, res);

  if (path === "/api/vapid-public-key") {
    return send(res, 200, { key: publicKey(), configured: isConfigured() });
  }

  const userId = readSession(req);
  const user = userId ? await getUser(userId) : null;

  if (path === "/api/me") {
    if (!user) return send(res, 200, { signedIn: false });
    return send(res, 200, {
      signedIn: true,
      email: user.email,
      name: user.name,
      picture: user.picture,
      needsReauth: !!user.needs_reauth,
      devices: await countSubscriptions(user.id),
      settings: await getSettings(user.id),
      pushConfigured: isConfigured(),
    });
  }

  if (!user) return send(res, 401, { error: "Not signed in" });

  if (path === "/api/events" && req.method === "GET") {
    if (url.searchParams.get("refresh") === "1") invalidateCache(user.id);
    try {
      const events = await fetchEvents(user);
      return send(res, 200, { events, now: new Date().toISOString() });
    } catch (err) {
      if (err instanceof ReauthRequired) {
        return send(res, 409, { error: "reauth_required" });
      }
      throw err;
    }
  }

  if (path === "/api/settings" && req.method === "POST") {
    const body = await json(req);
    return send(res, 200, { settings: await updateSettings(user.id, body) });
  }

  if (path === "/api/subscribe" && req.method === "POST") {
    const body = await json(req);
    await saveSubscription(user.id, body.subscription ?? body);
    return send(res, 200, { ok: true, devices: await countSubscriptions(user.id) });
  }

  if (path === "/api/unsubscribe" && req.method === "POST") {
    const body = await json(req);
    if (body.endpoint) await deleteSubscription(body.endpoint);
    return send(res, 200, { ok: true, devices: await countSubscriptions(user.id) });
  }

  if (path === "/api/test-push" && req.method === "POST") {
    const result = await sendToUser(user.id, {
      type: "test",
      title: "Hourglass is armed",
      body: "Notifications will reach you even with this app closed.",
    });
    return send(res, 200, result);
  }

  if (path === "/api/disconnect" && req.method === "POST") {
    await revoke(user.refresh_token);
    forgetAccessToken(user.id);
    await deleteUser(user.id);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  send(res, 404, { error: "Not found" });
}

/**
 * One scheduler pass. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`;
 * an external pinger must send the same header, or the secret as `?key=`.
 * Without CRON_SECRET set the endpoint is open, which is fine locally but
 * would let anyone burn your Calendar quota in production — so it refuses to
 * run unauthenticated when deployed.
 */
async function runTick(req, res) {
  const secret = process.env.CRON_SECRET;

  if (secret) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const presented =
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
      url.searchParams.get("key") ||
      "";
    if (!safeEqual(presented, secret)) {
      return send(res, 401, { error: "Unauthorized" });
    }
  } else if (process.env.VERCEL) {
    return send(res, 503, { error: "CRON_SECRET is not configured" });
  }

  const started = Date.now();
  try {
    await tick();
    return send(res, 200, { ok: true, ms: Date.now() - started });
  } catch (err) {
    console.error("[tick] failed:", err);
    return send(res, 500, { error: err.message });
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------------------------------------------------------- static -- */

async function serveStatic(res, path) {
  const relative = path === "/" ? "index.html" : path.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));

  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Forbidden" });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");

    const headers = {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control":
        relative === "sw.js" ? "no-cache" : "public, max-age=0, must-revalidate",
    };
    if (relative === "sw.js") headers["Service-Worker-Allowed"] = "/";

    res.writeHead(200, headers);
    res.end(await readFile(filePath));
  } catch {
    if (!extname(relative)) {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(html);
    }
    send(res, 404, { error: "Not found" });
  }
}

/* --------------------------------------------------------------- helpers -- */

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function json(req) {
  // Vercel's Node runtime parses the body and consumes the stream before the
  // handler runs, so prefer req.body and only read the stream when it is absent.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      try {
        return Promise.resolve(req.body ? JSON.parse(req.body) : {});
      } catch {
        return Promise.reject(new Error("Invalid JSON"));
      }
    }
    if (typeof req.body === "object") return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
