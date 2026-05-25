import Link from "next/link";
import { getCurrentAdmin } from "@/server/admin/auth";
import { GravitasMark } from "@/lib/branding/mark";
import { AdminNav } from "./admin-nav";

/**
 * Admin layout — shared chrome for every /admin/* route except /admin/login
 * (which has its own minimal layout via its page).
 *
 * The active-tab indicator (Phase 1.7) lives in <AdminNav>, a Client
 * Component that reads `usePathname()` and styles the matching link with a
 * filled chip. Sub-routes (e.g. `/admin/sessions/[id]`) keep the `Sessions`
 * tab active via a startsWith() match.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getCurrentAdmin();

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-paper-edge bg-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="flex items-center gap-2.5">
              <GravitasMark size="md" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Co-Pilot · Admin
              </span>
            </Link>
            {admin ? <AdminNav /> : null}
          </div>
          {admin ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-soft">{admin.email}</span>
              <form action="/admin/auth/signout" method="post">
                <button
                  type="submit"
                  className="rounded-full border border-paper-edge px-3 py-1 text-xs text-ink-soft transition hover:border-ink-muted hover:text-ink"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
