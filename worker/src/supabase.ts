import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/**
 * Shared Supabase client for the worker.
 *
 * Was inlined inside kb-ingest.ts; lifted here so call-log.ts (and any
 * future worker module) can reuse it. Service-role key — never expose to
 * a worker endpoint that proxies untrusted user input.
 *
 * Node 18 has no native WebSocket; @supabase/realtime-js fails at
 * construction time even when we never use realtime. Passing `ws` as
 * the transport satisfies the constructor; on Node 22+ it's a no-op.
 */

let cached: SupabaseClient | null | undefined;

export function getWorkerSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: "public" },
    realtime: {
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  });
  return cached;
}
