/**
 * Local development entry point.
 *
 * Wraps the shared handler in a real HTTP server and runs the in-process
 * scheduler. In production on Vercel neither exists: `api/index.js` serves the
 * same handler per request, and an external cron drives /api/tick.
 */
import { createServer } from "node:http";
import handler from "./app.js";
import { startScheduler } from "./scheduler.js";

const PORT = Number(process.env.PORT || 3000);

createServer(handler).listen(PORT, () => {
  console.log(`\n  Hourglass`);
  console.log(`  http://localhost:${PORT}\n`);

  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn("  GOOGLE_CLIENT_ID is not set — sign-in will fail.");
  }
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    console.warn("  No DATABASE_URL — every request will fail.");
  }
  console.log("");
});

startScheduler();
