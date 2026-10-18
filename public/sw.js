/**
 * Service worker: offline shell + the push handler.
 *
 * This file is why notifications arrive with the app closed. The browser's
 * push service keeps its own connection to the OS; when a message lands it
 * boots this worker on its own, with no page and no tab involved.
 */

const CACHE = "hourglass-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/badge-96.png",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first for API and auth (always fresh), cache-first for the shell,
 * runtime cache for fonts so the installed app works offline.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))) {
    return;
  }

  if (url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).catch(() =>
          request.mode === "navigate" ? caches.match("/index.html") : Response.error(),
        ),
    ),
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

/* ------------------------------------------------------------------ push -- */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: "Meeting Notifier", body: event.data?.text() ?? "" };
  }

  event.waitUntil(show(data));
});

async function show(data) {
  if (data.type === "test") {
    await self.registration.showNotification(data.title || "Test notification", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: "hourglass-test",
    });
    return;
  }

  const starting = data.minutesUntil <= 0;
  const title = starting
    ? `Starting now — ${data.title}`
    : `In ${data.minutesUntil} min — ${data.title}`;

  const body = [
    formatTime(data.start),
    data.organizer,
    data.location && !/^https?:/.test(data.location) ? data.location : null,
    data.joinUrl ? "Tap to join" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = data.joinUrl ? [{ action: "join", title: "Join" }] : [];

  await self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    // One notification per meeting: a re-push replaces rather than stacks.
    tag: `meeting-${data.eventId}`,
    renotify: true,
    requireInteraction: true,
    timestamp: data.start ? new Date(data.start).getTime() : Date.now(),
    data: { joinUrl: data.joinUrl ?? null },
    actions,
  });

  // If a window is open, let it speak the announcement.
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage(data);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const joinUrl = event.notification.data?.joinUrl;
  const target = joinUrl || "/";

  event.waitUntil(
    (async () => {
      // Prefer focusing an existing window over spawning another one, unless
      // we're opening an external meeting link.
      if (!joinUrl) {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const existing = clients.find((c) => c.url.startsWith(self.location.origin));
        if (existing) return existing.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});

/**
 * If the subscription is rotated by the browser, re-register it silently so
 * the server doesn't keep pushing into a dead endpoint.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch("/api/vapid-public-key");
      const { key } = await res.json();
      if (!key) return;

      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });

      await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    })(),
  );
});

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, "");
}
