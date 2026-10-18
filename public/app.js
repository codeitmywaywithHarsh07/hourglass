/**
 * Hourglass client — vanilla ES modules, no framework, no build step.
 */

const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  swRegistration: null,
  events: [],
  open: new Set(),
  speaking: false,
  installPrompt: null,
};

/* ------------------------------------------------------------------ boot -- */

init();

async function init() {
  // Boot runs *behind* the splash rather than after it, so the animation is
  // the loading indicator instead of a delay in front of one. allSettled, not
  // all: a failed boot must still drop the curtain.
  const boot = (async () => {
    showOAuthError();
    wireEvents();
    await registerServiceWorker();
    await loadMe();
  })();

  await Promise.allSettled([boot, window.__splash?.ready]);
  window.__splash?.dismiss();

  // Countdowns go stale fast; re-render on a short beat and refetch rarely.
  setInterval(render, 15_000);
  setInterval(() => { if (state.me?.signedIn) loadEvents(); }, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.me?.signedIn) loadEvents();
  });
}

function showOAuthError() {
  const error = new URLSearchParams(location.search).get("error");
  if (!error) return;
  const el = $("connect-error");
  el.textContent =
    error === "access_denied"
      ? "Google sign-in was cancelled."
      : `Sign-in failed: ${error}`;
  el.hidden = false;
  history.replaceState(null, "", "/");
}

async function loadMe() {
  const me = await api("/api/me");
  state.me = me;

  $("screen-connect").hidden = me.signedIn;
  $("screen-app").hidden = !me.signedIn;
  if (!me.signedIn) return;

  paintAccount(me);
  // The calendar must not wait on push setup — if the service worker is
  // unavailable (private window, unsupported browser) the app still works.
  await loadEvents();
  syncPushState().catch((err) => console.warn("Push state check failed", err));
}

function paintAccount(me) {
  $("sheet-name").textContent = me.name || me.email;
  $("sheet-email").textContent = me.email;
  $("lead-range").value = me.settings.leadMinutes;
  $("lead-value").textContent = me.settings.leadMinutes;
  $("toggle-voice").checked = me.settings.voiceEnabled;

  for (const id of ["avatar", "sheet-avatar"]) {
    const img = $(id);
    if (me.picture) {
      img.src = me.picture;
      img.hidden = false;
      if (id === "avatar") $("avatar-fallback").hidden = true;
    }
  }
}

/* ------------------------------------------------------------- calendar -- */

async function loadEvents({ force = false } = {}) {
  try {
    const data = await api(`/api/events${force ? "?refresh=1" : ""}`);
    state.events = data.events;
    $("loading").hidden = true;
    render();
  } catch (err) {
    $("loading").hidden = true;
    if (err.status === 409) {
      banner(
        "Google access expired. Reconnect to keep getting alerts.",
        "Reconnect",
        () => (location.href = "/auth/google"),
        true,
      );
    } else {
      toast("Couldn't read your calendar.");
    }
  }
}

function render() {
  if (!state.me?.signedIn) return;

  const now = Date.now();
  const upcoming = state.events.filter((e) => minutesUntil(e, now) > -60);

  $("empty").hidden = upcoming.length > 0;
  renderHero(upcoming[0], now);
  renderTimeline(upcoming, now);

  $("footer-status").textContent = state.events.length
    ? `${state.events.length} meeting${state.events.length === 1 ? "" : "s"} through tomorrow · updated ${timeOfDay(new Date())}`
    : "Nothing scheduled through tomorrow";
}

function renderHero(event, now) {
  const hero = $("hero");
  if (!event) {
    hero.hidden = true;
    return;
  }

  const mins = minutesUntil(event, now);
  const started = mins <= 0;

  hero.hidden = false;
  hero.classList.toggle("is-now", mins <= 15);
  $("hero-label").textContent = started ? "Happening now" : "Next up";
  $("hero-title").textContent = event.title;
  $("hero-countdown").innerHTML = countdownHtml(mins);
  $("hero-meta").textContent = [
    timeOfDay(new Date(event.start)),
    event.organizer,
    event.location && !/^https?:/.test(event.location) ? event.location : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const join = $("hero-join");
  join.hidden = !event.joinUrl;
  if (event.joinUrl) join.href = event.joinUrl;
}

function countdownHtml(mins) {
  if (mins <= 0) return `Now<small>started ${Math.abs(mins)}m ago</small>`;
  if (mins < 60) return `${mins}<small>min away</small>`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}<small>away</small>`;
}

function renderTimeline(events, now) {
  const root = $("timeline");
  root.textContent = "";

  let lastDay = null;
  for (const event of events) {
    const start = new Date(event.start);
    const day = dayLabel(start);
    if (day !== lastDay) {
      const h = document.createElement("p");
      h.className = "day";
      h.textContent = day;
      root.append(h);
      lastDay = day;
    }
    root.append(itemEl(event, minutesUntil(event, now)));
  }
}

function itemEl(event, mins) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "item";
  if (mins <= 0) item.classList.add("item--now");
  else if (mins <= 15) item.classList.add("item--soon");
  if (state.open.has(event.id)) item.classList.add("is-open");

  const time = document.createElement("span");
  time.className = "item__time";
  time.textContent = timeOfDay(new Date(event.start));

  const node = document.createElement("span");
  node.className = "item__node";

  const card = document.createElement("div");
  card.className = "item__card";

  const title = document.createElement("p");
  title.className = "item__title";
  title.append(event.title, chipEl(mins, event.start));

  const meta = document.createElement("p");
  meta.className = "item__meta";
  for (const bit of [
    event.organizer,
    event.attendees ? `${event.attendees} attending` : null,
    event.location && !/^https?:/.test(event.location) ? event.location : null,
  ].filter(Boolean)) {
    const span = document.createElement("span");
    span.textContent = bit;
    meta.append(span);
  }

  card.append(title, meta);

  const detail = document.createElement("div");
  detail.className = "item__detail";
  if (event.description) {
    const p = document.createElement("p");
    p.style.margin = "0";
    p.textContent = truncate(event.description, 240);
    detail.append(p);
  }
  if (event.joinUrl) {
    const a = document.createElement("a");
    a.className = "item__join";
    a.href = event.joinUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Join meeting";
    a.addEventListener("click", (e) => e.stopPropagation());
    detail.append(a);
  }
  if (!event.description && !event.joinUrl) {
    const p = document.createElement("p");
    p.style.margin = "0";
    p.textContent = "No link or description on this event.";
    detail.append(p);
  }
  card.append(detail);

  item.append(time, node, card);
  item.addEventListener("click", () => {
    if (state.open.has(event.id)) state.open.delete(event.id);
    else {
      state.open.add(event.id);
      if (state.me?.settings.voiceEnabled) speak(scriptFor(event));
    }
    item.classList.toggle("is-open");
  });

  return item;
}

function chipEl(mins, start) {
  const chip = document.createElement("span");
  chip.className = "chip";
  if (mins <= 0) chip.textContent = "now";
  else if (mins <= 15) chip.textContent = `in ${mins}m`;
  else if (mins < 60) chip.textContent = `${mins}m`;
  else chip.textContent = timeOfDay(new Date(start));
  return chip;
}

/* ------------------------------------------------------------ push setup -- */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    state.swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    navigator.serviceWorker.addEventListener("message", (event) => {
      // A push landed while the app is open — speak it if voice is on.
      if (event.data?.type === "meeting" && state.me?.settings.voiceEnabled) {
        speak(spokenFromPush(event.data));
      }
      if (event.data?.type === "meeting") loadEvents({ force: true });
    });
  } catch (err) {
    console.warn("Service worker registration failed", err);
  }
  return state.swRegistration;
}

/**
 * navigator.serviceWorker.ready never settles when registration failed, so
 * everything that needs the worker goes through this instead.
 */
async function swReady() {
  if (!state.swRegistration) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
}

async function syncPushState() {
  const reg = await swReady();
  const supported =
    !!reg && "PushManager" in window && "Notification" in window;

  if (!supported) {
    $("toggle-push").disabled = true;
    banner(
      isIosNotInstalled()
        ? "On iPhone, add Hourglass to your Home Screen first — that's the only way iOS allows push."
        : "This browser can't receive push notifications here.",
      null,
      null,
      true,
    );
    return;
  }

  if (!state.me.pushConfigured) {
    $("toggle-push").disabled = true;
    banner("Push isn't configured on the server (missing VAPID keys).", null, null, true);
    return;
  }

  const sub = await reg.pushManager.getSubscription();
  const granted = Notification.permission === "granted";
  const armed = granted && !!sub && state.me.devices > 0;

  $("toggle-push").checked = armed;
  $("live-dot").classList.toggle("is-live", armed);
  $("devices-sub").textContent = armed
    ? `Armed on ${state.me.devices} device${state.me.devices === 1 ? "" : "s"}. Works with the app closed.`
    : "Delivered even when the app is closed.";

  if (!armed) {
    banner(
      Notification.permission === "denied"
        ? "Notifications are blocked for this site — allow them in your browser settings."
        : "Turn on notifications to get alerted before meetings.",
      Notification.permission === "denied" ? null : "Turn on",
      enablePush,
      Notification.permission === "denied",
    );
  } else {
    hideBanner();
  }
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Notifications stay off until you allow them.");
    await syncPushState();
    return;
  }

  const { key } = await api("/api/vapid-public-key");
  if (!key) return toast("Server has no VAPID key.");

  const reg = await swReady();
  if (!reg) return toast("This browser can't register the background worker.");

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));

  const res = await api("/api/subscribe", { subscription: sub.toJSON() });
  state.me.devices = res.devices;
  toast("Armed. You'll be nudged before every meeting.");
  await syncPushState();
}

async function disablePush() {
  const reg = await swReady();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await api("/api/unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  state.me.devices = 0;
  await api("/api/settings", { enabled: false });
  toast("Notifications off on this device.");
  await syncPushState();
}

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* ----------------------------------------------------------------- voice -- */

function scriptFor(event) {
  const when = timeOfDay(new Date(event.start));
  const mins = minutesUntil(event);
  const lead =
    mins <= 0 ? "starting now" : mins < 60 ? `in ${mins} minutes` : `at ${when}`;
  const where = event.location && !/^https?:/.test(event.location)
    ? `, in ${event.location.split(",")[0]}`
    : "";
  const who = event.organizer ? `, with ${event.organizer}` : "";
  return `${event.title}, ${lead}${where}${who}.`;
}

function spokenFromPush(data) {
  const lead = data.minutesUntil <= 0 ? "is starting now" : `starts in ${data.minutesUntil} minutes`;
  return `Heads up. ${data.title} ${lead}.`;
}

function announceUpcoming() {
  if (state.speaking) {
    speechSynthesis.cancel();
    state.speaking = false;
    $("btn-voice").classList.remove("is-busy");
    return;
  }

  const soon = state.events
    .filter((e) => {
      const m = minutesUntil(e);
      return m > -60 && m < 120;
    })
    .slice(0, 3);

  if (!soon.length) {
    return speak("Nothing in the next two hours. You're clear.");
  }

  const intro = `You have ${soon.length} meeting${soon.length === 1 ? "" : "s"} coming up.`;
  speak([intro, ...soon.map(scriptFor)].join(" "));
}

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;

  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.1;
  utter.pitch = 1;

  const voice = pickVoice();
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang;
  }

  state.speaking = true;
  $("btn-voice").classList.add("is-busy");
  utter.onend = utter.onerror = () => {
    state.speaking = false;
    $("btn-voice").classList.remove("is-busy");
  };

  speechSynthesis.speak(utter);
}

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en"));
  if (!voices.length) return null;
  return (
    voices.find((v) => /Natural|Neural|Google|Samantha|Serena/i.test(v.name)) ?? voices[0]
  );
}

/* ---------------------------------------------------------------- wiring -- */

function wireEvents() {
  $("btn-refresh").addEventListener("click", async (e) => {
    e.currentTarget.classList.add("is-busy");
    await loadEvents({ force: true });
    e.currentTarget.classList.remove("is-busy");
    toast("Calendar refreshed.");
  });

  $("btn-voice").addEventListener("click", announceUpcoming);
  $("hero-speak").addEventListener("click", () => {
    const next = state.events.find((e) => minutesUntil(e) > -60);
    if (next) speak(scriptFor(next));
  });

  $("btn-settings").addEventListener("click", openSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
  });

  $("toggle-push").addEventListener("change", async (e) => {
    e.target.disabled = true;
    try {
      if (e.target.checked) {
        await api("/api/settings", { enabled: true });
        await enablePush();
      } else {
        await disablePush();
      }
    } finally {
      e.target.disabled = false;
    }
  });

  $("toggle-voice").addEventListener("change", async (e) => {
    const { settings } = await api("/api/settings", { voiceEnabled: e.target.checked });
    state.me.settings = settings;
  });

  const range = $("lead-range");
  range.addEventListener("input", () => ($("lead-value").textContent = range.value));
  range.addEventListener("change", async () => {
    const { settings } = await api("/api/settings", { leadMinutes: Number(range.value) });
    state.me.settings = settings;
    toast(`You'll be alerted ${settings.leadMinutes} minutes ahead.`);
  });

  $("btn-test").addEventListener("click", async () => {
    const res = await api("/api/test-push", {});
    toast(
      res.sent
        ? `Sent to ${res.sent} device${res.sent === 1 ? "" : "s"}. Close the app and it still arrives.`
        : "No devices registered yet — turn notifications on first.",
    );
  });

  $("btn-disconnect").addEventListener("click", async () => {
    if (!confirm("Disconnect Google and delete your data from this server?")) return;
    await api("/api/disconnect", {});
    location.href = "/";
  });

  $("banner-action").addEventListener("click", () => bannerAction?.());

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $("btn-install").hidden = false;
  });

  $("btn-install").addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $("btn-install").hidden = true;
  });
}

function openSheet() {
  $("scrim").hidden = false;
  $("sheet").hidden = false;
}

function closeSheet() {
  $("scrim").hidden = true;
  $("sheet").hidden = true;
}

/* ------------------------------------------------------- banner / toast -- */

let bannerAction = null;

function banner(text, actionLabel, action, bad = false) {
  $("banner").hidden = false;
  $("banner").classList.toggle("banner--bad", bad);
  $("banner-text").textContent = text;
  const btn = $("banner-action");
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || "";
  bannerAction = action;
}

function hideBanner() {
  $("banner").hidden = true;
  bannerAction = null;
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* --------------------------------------------------------------- helpers -- */

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const error = new Error(`${path} -> ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function minutesUntil(event, now = Date.now()) {
  return Math.round((new Date(event.start).getTime() - now) / 60000);
}

function timeOfDay(date) {
  return date
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, "");
}

function dayLabel(date) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (sameDay(date, today)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function isIosNotInstalled() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios && !window.matchMedia("(display-mode: standalone)").matches;
}
