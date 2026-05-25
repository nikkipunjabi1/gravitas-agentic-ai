import "server-only";
import { getSupabaseServerClient } from "@/server/supabase/server-client";

/**
 * Server-side helpers for verifying the current admin user.
 *
 * Pages call `requireAdmin()` and either get a `{ email }` back or the
 * middleware has already redirected them. The middleware is the gate; this
 * function exists so server components can DISPLAY the signed-in user
 * (e.g. in the layout header).
 */

export interface AdminUser {
  id: string;
  email: string;
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const client = await getSupabaseServerClient();
  if (!client) return null;
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user || !user.email) return null;
  return { id: user.id, email: user.email };
}
