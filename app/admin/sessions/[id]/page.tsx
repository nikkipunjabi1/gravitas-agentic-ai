import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionDetail } from "@/server/admin/queries";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

/**
 * /admin/sessions/[id] — single-session investigative view.
 *
 * Two-column layout on wide: left = timeline (visitor + agent turns, model
 * calls, UI actions in time order), right = summary card. The transcript
 * itself is already interleaved into the timeline, so no separate card.
 *
 * The timeline merges three sources by timestamp:
 *   - messages
 *   - model_calls
 *   - ui_actions_emitted
 * So an admin can see "Discovery node called Sonnet at 12:01:04 → emitted
 * AuditFindings at 12:01:08".
 */
export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getSessionDetail(id);
  if (!detail) return notFound();
  const { session, messages, modelCalls, uiActions } = detail;
  const timeline = buildTimeline(messages, modelCalls, uiActions);

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <Link
            href="/admin/sessions"
            className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink"
          >
            ← Sessions
          </Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
            Session
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {session.id}
          </p>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        {/* Timeline */}
        <section className="space-y-2">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Timeline
          </h2>
          <ul className="space-y-1.5">
            {timeline.length === 0 ? (
              <li className="rounded-xl border border-paper-edge bg-paper px-4 py-6 text-center text-sm text-ink-muted">
                No events for this session yet.
              </li>
            ) : (
              timeline.map((ev, i) => <TimelineEvent key={i} event={ev} />)
            )}
          </ul>
        </section>

        {/* Right column — Summary only. The transcript already lives in the
            left-side timeline interleaved with model calls / UI actions, so
            duplicating it here was noise. */}
        <aside className="space-y-5">
          <SummaryCard session={session} totalEvents={timeline.length} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline merge
// ---------------------------------------------------------------------------

type TimelineEvent =
  | {
      kind: "message";
      ts: string;
      role: string;
      content: string;
      emittedByNode: string | null;
    }
  | {
      kind: "model_call";
      ts: string;
      node: string | null;
      provider: string;
      model: string;
      purpose: string;
      costUsd: number;
      latencyMs: number | null;
      wasBlocked: boolean;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { kind: "ui_action"; ts: string; actionType: string; actionId: string };

function buildTimeline(
  messages: Awaited<ReturnType<typeof getSessionDetail>> extends infer T
    ? T extends { messages: infer M }
      ? M
      : never
    : never,
  modelCalls: Awaited<ReturnType<typeof getSessionDetail>> extends infer T
    ? T extends { modelCalls: infer M }
      ? M
      : never
    : never,
  uiActions: Awaited<ReturnType<typeof getSessionDetail>> extends infer T
    ? T extends { uiActions: infer M }
      ? M
      : never
    : never,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const m of messages) {
    out.push({
      kind: "message",
      ts: m.ts,
      role: m.role,
      content: m.content,
      emittedByNode: m.emittedByNode,
    });
  }
  for (const c of modelCalls) {
    out.push({
      kind: "model_call",
      ts: c.ts,
      node: c.node,
      provider: c.provider,
      model: c.model,
      purpose: c.purpose,
      costUsd: c.costUsd,
      latencyMs: c.latencyMs,
      wasBlocked: c.wasBlocked,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
    });
  }
  for (const u of uiActions) {
    out.push({ kind: "ui_action", ts: u.ts, actionType: u.actionType, actionId: u.actionId });
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

function TimelineEvent({ event }: { event: TimelineEvent }) {
  const ts = new Date(event.ts).toLocaleTimeString();

  if (event.kind === "message") {
    const isUser = event.role === "user";
    return (
      <li className="rounded-xl border border-paper-edge bg-paper p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {isUser ? "💬 visitor" : "🤖 assistant"}
            {event.emittedByNode ? ` · ${event.emittedByNode}` : ""}
          </span>
          <span className="font-mono text-[10px] text-ink-muted">{ts}</span>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">
          {event.content}
        </p>
      </li>
    );
  }

  if (event.kind === "model_call") {
    return (
      <li
        className={cn(
          "rounded-xl border bg-paper p-3",
          event.wasBlocked ? "border-severity-critical/30" : "border-paper-edge",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            ⚙️ model · {event.provider} · {event.model}
            {event.node ? ` · ${event.node}` : ""}
            {event.wasBlocked ? " · BLOCKED" : ""}
          </span>
          <span className="font-mono text-[10px] text-ink-muted">{ts}</span>
        </div>
        <p className="mt-1 text-xs text-ink-soft">
          <span className="font-mono">{event.purpose}</span>
          {event.inputTokens !== null ? ` · in ${event.inputTokens}` : ""}
          {event.outputTokens !== null ? ` · out ${event.outputTokens}` : ""}
          {` · $${event.costUsd.toFixed(4)}`}
          {event.latencyMs !== null ? ` · ${event.latencyMs}ms` : ""}
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          🎨 ui-action · {event.actionType}
        </span>
        <span className="font-mono text-[10px] text-ink-muted">{ts}</span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] text-ink-muted">id {event.actionId.slice(0, 8)}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Right column cards
// ---------------------------------------------------------------------------

function SummaryCard({
  session,
  totalEvents,
}: {
  session: Awaited<ReturnType<typeof getSessionDetail>> extends infer T
    ? T extends { session: infer S }
      ? S
      : never
    : never;
  totalEvents: number;
}) {
  const duration = session.endedAt
    ? Math.round(
        (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) /
          1000,
      )
    : null;
  return (
    <div className="space-y-2 rounded-xl border border-paper-edge bg-paper p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        Summary
      </h3>
      <Row label="Started" value={new Date(session.startedAt).toLocaleString()} />
      <Row label="Duration" value={duration !== null ? `${duration}s` : "in-flight"} />
      <Row label="Terminal" value={session.terminalNode ?? "—"} />
      <Row label="Industry" value={session.visitorIndustry ?? "—"} />
      <Row label="Role" value={session.visitorRole ?? "—"} />
      <Row label="Named problem" value={session.visitorNamedProblem ?? "—"} multiline />
      <Row label="URL" value={session.submittedUrl ?? "—"} mono />
      <Row label="Total cost" value={`$${session.totalCostUsd.toFixed(4)}`} mono />
      <Row label="Lead captured" value={session.leadCaptured ? "Yes" : "No"} />
      <Row label="Events" value={String(totalEvents)} />
      <Row label="IP hash" value={session.ipHash ? session.ipHash.slice(0, 12) + "…" : "—"} mono />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </p>
      <p
        className={cn(
          "text-sm text-ink",
          mono && "font-mono text-xs",
          multiline && "whitespace-pre-wrap leading-snug",
        )}
      >
        {value}
      </p>
    </div>
  );
}

