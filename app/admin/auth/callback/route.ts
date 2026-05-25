import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type SsrCookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * GET /admin/auth/callback — handles the magic-link redirect.
 *
 * Supabase sends the visitor here with `?code=...`. We exchange the code for
 * a session (Supabase Auth handles the cookie write) and bounce them on to
 * the `next` query param.
 *
 * On failure: redirect to /admin/login with reason=signin.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/admin";

  if (!code) {
    return failTo("/admin/login?reason=signin", req);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anon) {
    return failTo("/admin/login?reason=signin", req);
  }

  // Build the redirect response first so we can attach mutating cookies.
  const target = new URL(next.startsWith("/") ? next : "/admin", req.url);
  const response = NextResponse.redirect(target);

  const supabase = createServerClient(supabaseUrl, anon, {
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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return failTo("/admin/login?reason=signin", req);
  }

  return response;
}

function failTo(path: string, req: NextRequest): NextResponse {
  return NextResponse.redirect(new URL(path, req.url));
}
