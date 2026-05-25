import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import "server-only";

/**
 * Server-side Supabase client (service-role).
 *
 * - The service role bypasses RLS. ONLY import from server code.
 * - Singleton: the SDK pools connections internally, so one client across
 *   the process is correct.
 * - Configuration-optional: `getSupabaseAdminClient()` returns null when env
 *   vars are missing. Callers MUST handle that — they should gracefully
 *   degrade (no-op writes, in-memory fallbacks) rather than throw.
 *
 * Database typing — Phase 1 ships UNTYPED.
 *   The supabase-js v2.106+ generic carries an `__InternalSupabase` discriminator
 *   and a tight `GenericSchema` constraint. Hand-rolling a Database type that
 *   satisfies both is a lot of ceremony for a handful of RPCs; we'd rather
 *   spend that effort on `supabase gen types typescript` in Phase 2, where the
 *   schema is finalised. Until then, callers cast result shapes at point of
 *   use (each file's read paths are narrow and unit-testable).
 *
 * For browser-facing anon auth (magic link, sign-in), use a separate file at
 * `src/lib/supabase/browser.ts` (added in Batch P1.6 with the admin panel).
 */

let cached: SupabaseClient | null | undefined; // undefined = not resolved yet

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseAdminClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    auth: {
      // Service-role context — no sessions, no token refresh.
      autoRefreshToken: false,
      persistSession: false,
    },
    db: { schema: "public" },
    // Node 18 lacks native WebSocket. @supabase/realtime-js (transitive dep
    // of supabase-js) hard-checks for it at constructor time and throws
    // even if we never use realtime. Pass `ws` to keep the check happy;
    // no-op on Node 22+ where native WebSocket exists.
    realtime: {
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  });
  return cached;
}
