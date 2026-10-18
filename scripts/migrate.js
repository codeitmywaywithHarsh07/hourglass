/**
 * Creates the schema. Safe to run repeatedly.
 * Usage: npm run migrate
 */
import { migrate, query, closePool } from "../server/db.js";

await migrate();

const { rows } = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`,
);

console.log("\nSchema is up to date. Tables:");
for (const r of rows) console.log("  -", r.table_name);
console.log("");

await closePool();
