/**
 * Runs one scheduler pass by hand — the same work the cron triggers.
 * Usage: npm run tick
 */
import { tick } from "../server/scheduler.js";
import { configurePush } from "../server/push.js";
import { closePool } from "../server/db.js";

configurePush();
const started = Date.now();
await tick();
console.log(`tick finished in ${Date.now() - started}ms`);
await closePool();
