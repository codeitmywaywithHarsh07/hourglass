/**
 * Vercel entry point. vercel.json rewrites /api/* and /auth/* here; everything
 * else is served straight from public/ by the platform.
 */
export { default } from "../server/app.js";
