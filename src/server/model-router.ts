import "server-only";
import { ModelRouter } from "@/lib/models/router";
import {
  MemoryCostLedger,
  type CostLedger,
} from "@/lib/models/cost-ledger";
import {
  ConsoleCallLog,
  type CallLog,
} from "@/lib/models/call-log";
import { isSupabaseConfigured } from "./supabase/client";

/**
 * serverRouter — the production-side ModelRouter instance.
 *
 * Server routes (`/api/chat`, agent nodes) import this; tests and Phase-0
 * smoke continue to use the in-memory `router` from @/lib/models.
 *
 * Composition:
 *   - CostLedger: SupabaseCostLedger if env configured, else MemoryCostLedger.
 *   - CallLog:    SupabaseCallLog    if env configured, else ConsoleCallLog.
 *
 * Lazy import of the Supabase variants keeps the @/lib/models layer free of
 * Supabase concerns and avoids dragging the SDK into bundles that don't need
 * it (the Edge runtime, in particular).
 */

let cached: ModelRouter | null = null;

export function getServerRouter(): ModelRouter {
  if (cached) return cached;
  cached = new ModelRouter(resolveLedger(), resolveLog());
  return cached;
}

function resolveLedger(): CostLedger {
  if (!isSupabaseConfigured()) return new MemoryCostLedger();
  // Lazy require keeps Supabase out of pure-lib bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SupabaseCostLedger } = require("./cost-ledger-supabase") as typeof import("./cost-ledger-supabase");
  return new SupabaseCostLedger();
}

function resolveLog(): CallLog {
  if (!isSupabaseConfigured()) return new ConsoleCallLog();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SupabaseCallLog } = require("./call-log-supabase") as typeof import("./call-log-supabase");
  return new SupabaseCallLog();
}
