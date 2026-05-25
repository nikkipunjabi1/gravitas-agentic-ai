import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type SsrCookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * POST /admin/auth/signout — sign out the current admin user.
 *
 * Called from the admin layout's "Sign out" button. Clears the Supabase
 * session cookie and bounces to /admin/login.
 */
export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.redirect(new URL("/admin/login", req.url));
  }
  const response = NextResponse.redirect(new URL("/admin/login", req.url));
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(toSet: SsrCookieToSet[]) {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
  await supabase.auth.signOut().catch(() => undefined);
  return response;
}
