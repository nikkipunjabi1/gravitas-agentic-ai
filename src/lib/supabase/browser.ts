"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client (anon).
 *
 * Used by /admin/login for magic-link sign-in. Reads from the cookie set by
 * the auth-callback route, so subsequent admin pages render the right user
 * server-side via @supabase/ssr's matching createServerClient.
 *
 * Returns null when SUPABASE_URL / SUPABASE_ANON_KEY aren't set so the login
 * page can show a "Supabase not configured" message instead of crashing.
 */

let cached: SupabaseClient | null | undefined;

export function getBrowserSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createBrowserClient(url, key);
  return cached;
}

export function isSupabaseBrowserConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
