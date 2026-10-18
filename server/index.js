/**
 * Plain node:http server — routes, static files, no framework.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
import { startScheduler } from "./scheduler.js";
import {
  readSession,
  sessionCookie,
  clearSessionCookie,
  createState,
  verifyState,
} from "./session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (path === "/auth/google") return authStart(req, res);
    if (path === "/auth/callback") return await authCallback(req, res, url);
    if (path === "/auth/signout") return signOut(req, res);

    if (path.startsWith("/api/")) return await api(req, res, url, path);

    return await serveStatic(res, path);
  } catch (err) {
    console.error(`[server] ${req.method} ${path}:`, err);
    send(res, 500, { error: "Internal error" });
  }
});

/* ------------------------------------------------------------------ auth -- */

function authStart(req, res) {
  try {
    res.writeHead(302, { Location: authorizeUrl(createState()) });
    res.end();
  } catch (err) {
    // Missing client id / session secret: say so on the page rather than 500.
    redirect(res, `/?error=${encodeURIComponent(err.message)}`);
  }
}

async function authCallback(req, res, url) {
  const error = url.searchParams.get("error");
  if (error) return redirect(res, `/?error=${encodeURIComponent(error)}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !verifyState(state)) {
    return redirect(res, "/?error=invalid_state");
  }

  try {
    const user = await exchangeCode(code);
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": sessionCookie(user.id),
    });
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
  // Public: the client needs this before it can subscribe.
  if (path === "/api/vapid-public-key") {
    return send(res, 200, { key: publicKey(), configured: isConfigured() });
  }

  const userId = readSession(req);
  const user = userId ? getUser(userId) : null;

  if (path === "/api/me") {
    if (!user) return send(res, 200, { signedIn: false });
    return send(res, 200, {
      signedIn: true,
      email: user.email,
      name: user.name,
      picture: user.picture,
      needsReauth: !!user.needs_reauth,
      devices: countSubscriptions(user.id),
      settings: getSettings(user.id),
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
    return send(res, 200, { settings: updateSettings(user.id, body) });
  }

  if (path === "/api/subscribe" && req.method === "POST") {
    const body = await json(req);
    saveSubscription(user.id, body.subscription ?? body);
    return send(res, 200, { ok: true, devices: countSubscriptions(user.id) });
  }

  if (path === "/api/unsubscribe" && req.method === "POST") {
    const body = await json(req);
    if (body.endpoint) deleteSubscription(body.endpoint);
    return send(res, 200, { ok: true, devices: countSubscriptions(user.id) });
  }

  if (path === "/api/test-push" && req.method === "POST") {
    const result = await sendToUser(user.id, {
      type: "test",
      title: "Meeting Notifier is armed",
      body: "Notifications will reach you even with this app closed.",
    });
    return send(res, 200, result);
  }

  if (path === "/api/disconnect" && req.method === "POST") {
    await revoke(user.refresh_token);
    forgetAccessToken(user.id);
    deleteUser(user.id);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(),
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  send(res, 404, { error: "Not found" });
}

/* ---------------------------------------------------------------- static -- */

async function serveStatic(res, path) {
  const relative = path === "/" ? "index.html" : path.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));

  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Forbidden" });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");

    const ext = extname(filePath);
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": info.size,
    };

    // The service worker must never be served stale, or users get stuck on an
    // old push handler. Hashed-free assets stay on a short revalidating cache.
    headers["Cache-Control"] =
      relative === "sw.js" ? "no-cache" : "public, max-age=0, must-revalidate";
    if (relative === "sw.js") headers["Service-Worker-Allowed"] = "/";

    res.writeHead(200, headers);
    res.end(await readFile(filePath));
  } catch {
    // Single-page app: unknown non-asset paths fall back to the shell.
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

/* ----------------------------------------------------------------- boot -- */

configurePush();
startScheduler();

server.listen(PORT, () => {
  console.log(`\n  Meeting Notifier PWA`);
  console.log(`  http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn("  GOOGLE_CLIENT_ID is not set — sign-in will fail.\n");
  }
});
