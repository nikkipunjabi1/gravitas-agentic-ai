import Link from "next/link";
import {
  getDashboardSnapshot,
  listRecentOpeners,
  listRecentSessions,
} from "@/server/admin/queries";
import { isSupabaseConfigured } from "@/server/supabase/client";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

/**
 * /admin — dashboard.
 *
 * Tile strip + recent-sessions list + recent-openers list. Server Component
 * that fetches everything in parallel.
 *
 * When Supabase isn't configured, renders an empty-state with setup
 * instructions instead of a row of zero tiles.
 */
export default async function AdminDashboard() {
  if (!isSupabaseConfigured()) {
    return <NotConfigured />;
  }

  const [snap, recentSessions, recentOpeners] = await Promise.all([
    getDashboardSnapshot(),
    listRecentSessions(10),
    listRecentOpeners(10),
  ]);

  const spendPct = snap.capUsd > 0 ? Math.min(100, (snap.todaySpendUsd / snap.capUsd) * 100) : 0;
  const spendTone =
    spendPct >= 90 ? "critical" : spendPct >= 70 ? "warning" : "ok";

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Today</h1>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Today's spend"
          value={`$${snap.todaySpendUsd.toFixed(2)}`}
          subtitle={`of $${snap.capUsd.toFixed(0)} cap`}
          progress={spendPct}
          tone={spendTone}
        >
          <Sparkline points={snap.spendByDay.map((d) => d.usd)} />
        </Tile>
        <Tile
          label="Sessions today"
          value={String(snap.sessionsToday)}
          subtitle={delta(snap.sessionsToday, snap.sessionsYesterday) + " vs yesterday"}
          tone="default"
        />
        <Tile
          label="Sessions this week"
          value={String(snap.sessionsThisWeek)}
          subtitle={delta(snap.sessionsThisWeek, snap.sessionsLastWeek) + " vs last week"}
          tone="default"
        />
        <Tile
          label="Leads today"
          value={String(snap.leadsCapturedToday)}
          subtitle="Lead form + waitlist"
          tone="default"
        />
        <Tile
          label="Cap-blocked today"
          value={String(snap.todayCallsBlocked)}
          subtitle="model_calls.was_blocked"
          tone={snap.todayCallsBlocked > 0 ? "critical" : "default"}
        />
        <Tile
          label="Lite-mode swaps"
          value={String(snap.todayLiteSubstitutions)}
          subtitle="voice-light → Ollama (cap-driven)"
          tone={snap.todayLiteSubstitutions > 0 ? "warning" : "default"}
        />
        <Tile
          label="Rate-limited IPs"
          value={String(snap.rateLimitedIpsToday)}
          subtitle="Distinct ip_hash at quota"
          tone="default"
        />
        <Tile
          label="Calls made today"
          value={String(snap.todayCallsMade)}
          subtitle="Anthropic + Ollama"
          tone="default"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Recent sessions
          </h2>
          <ul className="space-y-1.5 rounded-xl border border-paper-edge bg-paper">
            {recentSessions.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">
                No sessions yet today.
              </li>
            ) : (
              recentSessions.slice(0, 10).map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/admin/sessions/${s.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-paper-soft/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">
                        {s.submittedUrl ?? s.visitorIndustry ?? "(no URL)"}
                      </p>
                      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                        {formatRelative(s.startedAt)} · {s.terminalNode ?? "in-flight"}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-ink-muted">
                      ${s.totalCostUsd.toFixed(2)}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="space-y-2">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Recent openers
          </h2>
          <ul className="space-y-1.5 rounded-xl border border-paper-edge bg-paper">
            {recentOpeners.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-ink-muted">
                No visitor messages yet.
              </li>
            ) : (
              recentOpeners.slice(0, 10).map((q) => (
                <li key={q.sessionId}>
                  <Link
                    href={`/admin/sessions/${q.sessionId}`}
                    className="block px-4 py-2.5 transition hover:bg-paper-soft/60"
                  >
                    <p className="line-clamp-2 text-sm text-ink">{q.content}</p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      {formatRelative(q.ts)}
                    </p>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Tile({
  label,
  value,
  subtitle,
  progress,
  tone,
  children,
}: {
  label: string;
  value: string;
  subtitle: string;
  progress?: number;
  tone: "default" | "ok" | "warning" | "critical";
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-paper p-4 shadow-sm",
        tone === "critical" && "border-severity-critical/30",
        tone === "warning" && "border-severity-medium/30",
        tone === "ok" && "border-severity-low/30",
        tone === "default" && "border-paper-edge",
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-semibold leading-none text-ink">
        {value}
      </p>
      <p className="mt-1 text-[11px] text-ink-muted">{subtitle}</p>
      {typeof progress === "number" ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-edge">
          <div
            style={{ width: `${Math.min(100, progress)}%` }}
            className={cn(
              "h-full transition-all",
              tone === "critical" && "bg-severity-critical",
              tone === "warning" && "bg-severity-medium",
              tone === "ok" && "bg-severity-low",
              tone === "default" && "bg-accent",
            )}
          />
        </div>
      ) : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 0.01);
  const width = 100;
  const height = 24;
  const step = width / (points.length - 1);
  const path = points
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-6 w-full text-ink-muted">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.6} />
    </svg>
  );
}

function delta(now: number, prev: number): string {
  const d = now - prev;
  if (d === 0) return "±0";
  return d > 0 ? `+${d}` : `${d}`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function NotConfigured() {
  return (
    <div className="rounded-xl border border-paper-edge bg-paper p-6">
      <h1 className="font-display text-xl font-semibold text-ink">
        Supabase isn&apos;t configured
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        The admin panel reads from <code className="font-mono">SUPABASE_URL</code>{" "}
        + <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> on the server
        and from <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> +{" "}
        <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in the browser.
      </p>
      <ol className="mt-4 list-inside list-decimal space-y-1.5 text-sm text-ink-soft">
        <li>
          Provision a Supabase project at{" "}
          <a className="underline" href="https://supabase.com/dashboard">
            supabase.com
          </a>
          .
        </li>
        <li>
          Run the migrations in{" "}
          <code className="font-mono">supabase/migrations/</code> via the SQL editor.
        </li>
        <li>
          Set the four env vars in <code className="font-mono">.env.local</code> and restart.
        </li>
      </ol>
    </div>
  );
}
