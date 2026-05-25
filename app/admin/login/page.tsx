import { LoginForm } from "./login-form";
import { GravitasMark } from "@/lib/branding/mark";

/**
 * /admin/login — magic-link sign-in form.
 *
 * Server Component shell + Client Component form. The reason query param
 * surfaces context from the middleware redirect:
 *   ?reason=signin       — no session
 *   ?reason=unauthorized — wrong email domain
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; next?: string }>;
}) {
  const params = await searchParams;
  const reason = params.reason ?? null;
  const next = params.next ?? "/admin";

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6 py-12">
      <div className="w-full max-w-sm space-y-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <GravitasMark size="lg" />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Co-Pilot · Admin
          </p>
        </header>

        {reason === "unauthorized" ? (
          <div
            role="alert"
            className="rounded-xl border border-severity-critical/30 bg-severity-critical/5 px-4 py-3 text-sm text-severity-critical"
          >
            That email isn&apos;t allowed in the admin panel. Sign in with a
            {" "}
            <span className="font-mono">@thisisgravitas.com</span> address.
          </div>
        ) : null}

        <LoginForm next={next} />

        <p className="text-center font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          @{process.env.ADMIN_EMAIL_DOMAIN ?? "thisisgravitas.com"} addresses only
        </p>
      </div>
    </main>
  );
}
