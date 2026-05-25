import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type SsrCookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Middleware — gates every /admin/* route.
 *
 * Flow:
 *   1. /admin/login + /admin/auth/* are always allowed (you have to be able
 *      to reach the login form unauthenticated).
 *   2. Everything else requires a Supabase session via @supabase/ssr.
 *   3. The signed-in email's domain must match ADMIN_EMAIL_DOMAIN
 *      (default `thisisgravitas.com`). The 0002_admin_email_guard.sql trigger
 *      also enforces this at the database level for sign-ups; this layer
 *      enforces it on read so a stale session can't access /admin if the
 *      allowed domain changes.
 *
 * When Supabase isn't configured (dev clones with no env vars), middleware
 * lets requests through but the admin pages themselves render a "Supabase
 * not configured" placeholder. We deliberately don't 500 — dev visitors
 * exploring `/admin` shouldn't see an internal error page.
 *
 * Reference: https://supabase.com/docs/guides/auth/server-side/nextjs
 */

const ADMIN_PREFIX = "/admin";
const PUBLIC_ADMIN_PATHS = [
  "/admin/login",
  "/admin/auth/callback",
  "/admin/auth/signout",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith(ADMIN_PREFIX)) {
    return NextResponse.next();
  }
  if (PUBLIC_ADMIN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Dev convenience — let the page render its own "configure me" message.
    return NextResponse.next();
  }

  // Build a response we can mutate cookies on (Supabase token refresh).
  const response = NextResponse.next({ request: req });
  const supabase = createServerClient(url, anonKey, {
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

  // getUser() consults the auth server — IMPORTANT, do not use getSession()
  // for trust decisions (the latter only reads the cookie without verifying).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToLogin(req, "signin");
  }

  const allowedDomain = (process.env.ADMIN_EMAIL_DOMAIN ?? "thisisgravitas.com").toLowerCase();
  const email = user.email?.toLowerCase() ?? "";
  const domain = email.split("@")[1];
  if (!domain || domain !== allowedDomain) {
    // Sign them out so a stale session can't loop.
    await supabase.auth.signOut().catch(() => undefined);
    return redirectToLogin(req, "unauthorized");
  }

  return response;
}

function redirectToLogin(req: NextRequest, reason: "signin" | "unauthorized") {
  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.searchParams.set("reason", reason);
  // Preserve the originally-requested path so we can bounce back after sign-in.
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Match only /admin/*; skip Next internals + static assets.
  matcher: ["/admin/:path*"],
};
