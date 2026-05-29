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
        <Link
          href={`/admin/sessions/${id}/flow`}
          className="rounded-full border border-paper-edge px-3 py-1 text-xs text-ink-soft transition hover:border-ink-muted hover:text-ink"
        >
          View Flow →
        </Link>
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

/**
 * Visual treatment by event kind — keeps long sessions scannable:
 *
 *   Visitor message    →  right-aligned ink bubble (chat-style)
 *   Assistant message  →  left-aligned paper bubble (chat-style)
 *   Model call         →  thin muted row, no card chrome — telemetry
 *   UI action emitted  →  tiny accent pill, inline
 *
 * The model_call + ui_action rows are intentionally compact so the
 * conversation reads top-to-bottom without telemetry shouting over it.
 * For full inspection of model calls (request/response payloads), use
 * the "View Flow →" link in the header — that page has the click-to-
 * expand rows.
 */
function TimelineEvent({ event }: { event: TimelineEvent }) {
  const ts = new Date(event.ts).toLocaleTimeString();

  if (event.kind === "message") {
    const isUser = event.role === "user";
    return (
      <li className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
        <div
          className={cn(
            "max-w-[78%] rounded-2xl px-4 py-3",
            isUser
              ? "bg-ink text-paper"
              : "border border-paper-edge bg-paper text-ink",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-between gap-3 font-mono text-[9px] uppercase tracking-widest",
              isUser ? "text-paper/60" : "text-ink-muted",
            )}
          >
            <span>
              {isUser ? "visitor" : "assistant"}
              {event.emittedByNode ? ` · ${event.emittedByNode}` : ""}
            </span>
            <span>{ts}</span>
          </div>
          <p
            className={cn(
              "mt-1.5 whitespace-pre-wrap text-sm leading-relaxed",
              isUser ? "text-paper" : "text-ink",
            )}
          >
            {event.content}
          </p>
        </div>
      </li>
    );
  }

  if (event.kind === "model_call") {
    return (
      <li
        className={cn(
          "flex items-center justify-between gap-3 border-l-2 pl-3 py-1 text-[11px]",
          event.wasBlocked
            ? "border-severity-critical/50 text-severity-critical"
            : "border-paper-edge text-ink-muted",
        )}
      >
        <div className="flex items-center gap-2 truncate">
          <span className="font-mono text-[9px] uppercase tracking-widest opacity-70">
            model
          </span>
          <ProviderChip provider={event.provider} />
          <code className="truncate font-mono text-ink-soft">{event.model}</code>
          {event.node ? (
            <span className="font-mono text-[9px] uppercase tracking-widest opacity-60">
              {event.node}
            </span>
          ) : null}
          <span className="font-mono text-[9px] uppercase tracking-widest opacity-60">
            {event.purpose}
          </span>
          {event.wasBlocked ? (
            <span className="rounded-full bg-severity-critical/15 px-1.5 text-[9px] uppercase tracking-wide">
              blocked
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
          {event.inputTokens !== null && event.outputTokens !== null ? (
            <span>
              in {event.inputTokens} · out {event.outputTokens}
            </span>
          ) : null}
          {event.latencyMs !== null ? <span>{formatLatency(event.latencyMs)}</span> : null}
          {event.costUsd > 0 ? <span>${event.costUsd.toFixed(4)}</span> : null}
          <span className="opacity-70">{ts}</span>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 pl-3 py-0.5 text-[11px] text-ink-muted">
      <span className="font-mono text-[9px] uppercase tracking-widest opacity-70">canvas</span>
      <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">
        {event.actionType}
      </span>
      <span className="ml-auto font-mono text-[10px] opacity-70">{ts}</span>
    </li>
  );
}

function ProviderChip({ provider }: { provider: string }) {
  const styles: Record<string, string> = {
    anthropic: "bg-violet-100 text-violet-900",
    ollama: "bg-emerald-100 text-emerald-900",
    "google-psi": "bg-blue-100 text-blue-900",
    playwright: "bg-amber-100 text-amber-900",
  };
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
        styles[provider] ?? "bg-ink/10 text-ink-soft",
      )}
    >
      {provider}
    </span>
  );
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

