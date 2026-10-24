/**
 * Shared test setup.
 *
 * Database-backed tests truncate tables, so they refuse to run against
 * anything that isn't obviously a test database. Pointing TEST_DATABASE_URL at
 * a real database should fail loudly, not quietly wipe it.
 *
 * They also have to run serially — every file truncates the same database, so
 * the test runner's default parallelism makes them clobber each other. Hence
 * --test-concurrency=1 in the npm script.
 */
const RAW = process.env.TEST_DATABASE_URL;

function isObviouslyATestDatabase(url) {
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return /(^|[_-])test($|[_-])|_test$/.test(name);
  } catch {
    return false;
  }
}

export const TEST_DATABASE_URL = RAW ?? null;

export const dbSkip = RAW
  ? false
  : "set TEST_DATABASE_URL to run database tests (e.g. postgresql://you@localhost:5432/hourglass_test)";

if (RAW && !isObviouslyATestDatabase(RAW)) {
  throw new Error(
    `Refusing to run: TEST_DATABASE_URL database name must contain "test" ` +
      `(these tests TRUNCATE tables). Got: ${new URL(RAW).pathname}`,
  );
}

if (RAW) {
  // db.js resolves its connection on first query, so this must be set before
  // anything imports it.
  process.env.DATABASE_URL = RAW;
}

/** Imports db.js, applies the schema and empties every table. */
export async function freshDb() {
  const db = await import("../server/db.js");
  await db.migrate();
  await db.query("TRUNCATE users RESTART IDENTITY CASCADE");
  return db;
}

/** A Google Calendar event as the API returns it. */
export function googleEvent(overrides = {}) {
  const start = overrides.startsInMinutes ?? 30;
  delete overrides.startsInMinutes;
  const at = new Date(Date.now() + start * 60000).toISOString();
  return {
    id: "evt",
    summary: "Meeting",
    status: "confirmed",
    start: { dateTime: at },
    end: { dateTime: at },
    ...overrides,
  };
}

/** An attendee list containing the signed-in user with the given RSVP. */
export function withSelf(responseStatus, others = []) {
  return [{ email: "me@example.com", self: true, responseStatus }, ...others];
}
