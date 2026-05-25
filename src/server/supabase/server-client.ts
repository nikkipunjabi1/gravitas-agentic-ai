import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

type SsrCookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Cookie-aware Supabase client for Server Components / Route Handlers.
 *
 * Reads `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the
 * anon key is fine here — RLS gates what an admin can see). Cookies flow via
 * `next/headers` so the session set by /admin/login is visible to admin
 * pages.
 *
 * For service-role operations (writing logs, deleting retention rows) keep
 * using `getSupabaseAdminClient` from ./client. This client is for
 * USER-SCOPED reads — it returns the admin's identity via getUser() and
 * respects RLS.
 *
 * Returns null when the public env vars aren't set (dev convenience).
 */

export async function getSupabaseServerClient(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  // `cookies()` returns a Promise in Next 15 (was synchronous in 14).
  // Awaiting here keeps us forward-compatible.
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet: SsrCookieToSet[]) {
        // Server Components can't mutate cookies; @supabase/ssr handles that
        // gracefully when called from a Server Component. From Route Handlers
        // + middleware (which CAN mutate), this is the standard pattern.
        for (const { name, value, options } of toSet) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // Server Component context — no mutation allowed. Token refresh
            // will happen the next time the middleware runs.
          }
        }
      },
    },
  });
}

export function isSupabaseServerConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
