import {
  getKbSettings,
  getKbNotificationSettings,
  getCurrentRun,
  getLastCompletedRun,
  listKbRuns,
  listKbDocuments,
  computeNextDue,
  CADENCE_OPTIONS,
} from "@/server/admin/kb";
import { isSupabaseConfigured } from "@/server/supabase/client";
import { KbControls } from "./kb-controls";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

/**
 * /admin/kb — Phase 1.7 KB control surface.
 *
 * Server component fetches initial state (settings, current run, last
 * completed run, recent runs). The interactive bits (cadence picker,
 * Run-now button, polling progress) live in <KbControls>.
 */
export default async function AdminKbPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="rounded-xl border border-paper-edge bg-paper p-6">
        <h1 className="font-display text-xl font-semibold text-ink">
          Supabase isn&apos;t configured
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          The KB control page reads ingest state from Supabase. Set the four
          Supabase env vars and run the migrations under{" "}
          <code className="font-mono">supabase/migrations/</code> to enable.
        </p>
      </div>
    );
  }

  const [settings, notifications, currentRun, lastCompleted, recentRuns, indexedDocs] = await Promise.all([
    getKbSettings(),
    getKbNotificationSettings(),
    getCurrentRun(),
    getLastCompletedRun(),
    listKbRuns(20),
    listKbDocuments(100),
  ]);

  const nextDue = computeNextDue(
    settings.cadenceHours,
    lastCompleted?.endedAt ?? null,
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">
          Knowledge base
        </h1>
        <p className="text-sm text-ink-soft">
          Controls the Gravitas KB ingest the agent uses for grounding. KB
          refreshes are non-blocking — chat sessions keep reading the
          previous vectors while a run upserts new ones.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatusTile label="Sitemap">
          <p className="font-mono text-[11px] text-ink break-all">
            {settings.sitemapUrl}
          </p>
        </StatusTile>
        <StatusTile label="Cadence">
          <p className="text-sm text-ink">{cadenceLabel(settings.cadenceHours)}</p>
        </StatusTile>
        <StatusTile label="Last completed">
          <p className="text-sm text-ink">
            {lastCompleted?.endedAt
              ? new Date(lastCompleted.endedAt).toLocaleString()
              : "—"}
          </p>
          {lastCompleted ? (
            <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
              {lastCompleted.pagesFetched} fetched · {lastCompleted.pagesUnchanged} unchanged ·{" "}
              {lastCompleted.pagesErrored} errored
            </p>
          ) : null}
        </StatusTile>
        <StatusTile label="Next due">
          <p className="text-sm text-ink">
            {nextDue ? formatNextDue(nextDue) : "Manual only"}
          </p>
        </StatusTile>
      </section>

      <KbControls
        initialCadenceHours={settings.cadenceHours}
        cadenceOptions={CADENCE_OPTIONS}
        initialRun={currentRun}
        initialNotifications={notifications}
      />

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Indexed pages
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {indexedDocs.length} {indexedDocs.length === 1 ? "page" : "pages"} ·{" "}
            {indexedDocs.reduce((s, d) => s + d.chunkCount, 0)} chunks in Chroma
          </span>
        </div>
        <p className="text-xs text-ink-soft">
          Each row = one URL ingested into the <code className="font-mono text-ink">{settings.sitemapUrl.replace(/^https?:\/\//, "").split("/")[0]}</code> KB. Chunks are stored as vectors in ChromaDB; this table is the manifest the worker diffs against on each incremental refresh.
        </p>
        <div className="overflow-x-auto rounded-xl border border-paper-edge bg-paper">
          <table className="w-full text-sm">
            <thead className="border-b border-paper-edge bg-paper-soft/60 text-left">
              <tr>
                <Th>URL</Th>
                <Th align="right">Chunks</Th>
                <Th>Last indexed</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-edge">
              {indexedDocs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-ink-muted">
                    No pages indexed yet. Click <strong>Refresh now</strong> above to start the first run.
                  </td>
                </tr>
              ) : (
                indexedDocs.map((d) => (
                  <tr key={d.url} className="text-ink">
                    <Td>
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-ink-soft underline decoration-paper-edge underline-offset-2 hover:text-ink hover:decoration-ink-muted"
                      >
                        {d.url.replace(/^https?:\/\//, "")}
                      </a>
                    </Td>
                    <Td align="right" mono>{d.chunkCount}</Td>
                    <Td mono>
                      {d.indexedAt ? new Date(d.indexedAt).toLocaleString() : "—"}
                    </Td>
                    <Td>
                      <DocStatusChip status={d.status} errorMessage={d.errorMessage} />
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Recent runs
        </h2>
        <div className="overflow-x-auto rounded-xl border border-paper-edge bg-paper">
          <table className="w-full text-sm">
            <thead className="border-b border-paper-edge bg-paper-soft/60 text-left">
              <tr>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Mode</Th>
                <Th>By</Th>
                <Th align="right">Fetched</Th>
                <Th align="right">Unchanged</Th>
                <Th align="right">Errored</Th>
                <Th align="right">Chunks</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-edge">
              {recentRuns.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-ink-muted">
                    No runs recorded yet. Click <strong>Refresh now</strong> above to start one.
                  </td>
                </tr>
              ) : (
                recentRuns.map((r) => (
                  <tr key={r.id} className="text-ink">
                    <Td>{new Date(r.startedAt).toLocaleString()}</Td>
                    <Td>{formatDuration(r.startedAt, r.endedAt)}</Td>
                    <Td>{r.mode}</Td>
                    <Td mono>{r.triggeredBy}</Td>
                    <Td align="right" mono>
                      {r.pagesFetched}
                    </Td>
                    <Td align="right" mono>
                      {r.pagesUnchanged}
                    </Td>
                    <Td align="right" mono>
                      {r.pagesErrored}
                    </Td>
                    <Td align="right" mono>
                      {r.chunksEmbedded}
                    </Td>
                    <Td>
                      <StatusChip status={r.status} />
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function StatusTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-paper-edge bg-paper p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-4 py-2.5",
        align === "right" && "text-right",
        mono && "font-mono text-xs",
      )}
    >
      {children}
    </td>
  );
}

function DocStatusChip({
  status,
  errorMessage,
}: {
  status: string;
  errorMessage: string | null;
}) {
  const tone =
    status === "indexed"
      ? "border-severity-low/30 bg-severity-low/10 text-severity-low"
      : status === "error"
        ? "border-severity-critical/30 bg-severity-critical/10 text-severity-critical"
        : "border-paper-edge bg-paper-soft text-ink-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
        tone,
      )}
      title={errorMessage ?? undefined}
    >
      {status}
    </span>
  );
}

function StatusChip({ status }: { status: "running" | "completed" | "failed" }) {
  const map: Record<typeof status, string> = {
    running: "border-accent/30 bg-accent/10 text-accent",
    completed: "border-severity-low/30 bg-severity-low/10 text-severity-low",
    failed: "border-severity-critical/30 bg-severity-critical/10 text-severity-critical",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
        map[status],
      )}
    >
      {status}
    </span>
  );
}

function cadenceLabel(hours: number | null): string {
  if (hours === null) return "Manual only";
  if (hours === 24) return "Every 24 hours";
  if (hours === 168) return "Every 7 days";
  if (hours === 720) return "Every 30 days";
  return `Every ${hours} hours`;
}

function formatNextDue(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "Due now";
  const hrs = Math.round(diffMs / 3600_000);
  if (hrs < 1) return "in < 1 hour";
  if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
