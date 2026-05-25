/**
 * env-loader — load .env.local from the repo root into process.env.
 *
 * Why this exists:
 *   - Next.js loads .env.local automatically. The worker is a separate
 *     workspace running under `tsx`, which does NOT load env files.
 *   - Node 20+ has --env-file natively, but we still support Node 18 in dev
 *     so we use dotenv for the broadest compatibility.
 *
 * MUST be imported as the FIRST statement of worker/src/index.ts. ES module
 * imports evaluate in source order — anything that reads process.env at
 * module-load time (Supabase clients, env-based config) must come after this.
 *
 * Loads .env.local first (higher priority), then .env as a fallback. Neither
 * file overrides values already present in process.env, so shell-supplied
 * env vars still win (handy for CI / Docker).
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// worker/src/env-loader.ts → ../../ is the repo root
const repoRoot = resolve(here, "..", "..");

loadEnv({ path: resolve(repoRoot, ".env.local"), override: false });
loadEnv({ path: resolve(repoRoot, ".env"), override: false });
