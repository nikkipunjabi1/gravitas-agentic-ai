import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionDetail } from "@/server/admin/queries";
import { cn } from "@/lib/utils/cn";
import { MermaidDiagram } from "./mermaid-diagram";
import { buildDiagram, type DiagramSessionEvent } from "./build-diagram";

export const dynamic = "force-dynamic";

/**
 * /admin/sessions/[id]/flow — per-session agent-flow visualisation.
 *
 * Companion to /admin/sessions/[id], which shows a flat timeline. This view
 * groups events by agent NODE so the operator can see the pipeline shape:
 *
 *   Discovery → Audit → Strategy → Solution Mapping → Output
 *
 * Each node card lists the model calls it made, the UI actions it emitted,
 * and the assistant messages it streamed. Phases that didn't run for this
 * session (e.g. a "hi" chat skips Audit + Strategy + Mapping + Output) are
 * rendered greyed-out with a "not run" pill so the operator can see at a
 * glance how far the pipeline got.
 *
 * Source of truth: the same Supabase tables the flat timeline reads —
 * `messages`, `model_calls`, `ui_actions_emitted`. With P1.12 the worker
 * also logs PSI + Playwright calls into `model_calls`, so those appear
 * here too (provider="google-psi" / "playwright").
 */

interface NodeBucket {
  label: string;
  node: string;
  description: string;
  messages: ReturnType<typeof toMessages>;
  modelCalls: ReturnType<typeof toModelCalls>;
  uiActions: ReturnType<typeof toUiActions>;
}

export default async function SessionFlowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getSessionDetail(id);
  if (!detail) return notFound();
  const { session, messages, modelCalls, uiActions } = detail;

  // Canonical phase order — matches the graph in src/agents/graph.ts.
  const PHASES: Array<{ key: string; label: string; description: string }> = [
    {
      key: "discovery",
      label: "Discovery",
      description:
        "Classifies intent, extracts URL/problem, streams the first visitor-facing reply.",
    },
    {
      key: "audit",
      label: "Audit",
      description:
        "Runs Lighthouse via Google PSI + a Playwright crawl in parallel, derives heuristic findings, narrates them.",
    },
    {
      key: "strategy",
      label: "Strategy",
      description:
        "Pulls Gravitas KB excerpts, asks Claude for a strict-JSON Maturity/Roadmap/Themes synthesis, narrates.",
    },
    {
      key: "solution-mapping",
      label: "Solution Mapping",
      description:
        "Deterministic mapping from findings → Gravitas service areas. No LLM call.",
    },
    {
      key: "output",
      label: "Output",
      description:
        "Closing turn — summary, named-contact handoff, bilingual sign-off.",
    },
  ];

  // Terminal failure phases get appended only when they actually fired.
  const TERMINAL_PHASES: Array<{ key: string; label: string; description: string }> = [
    {
      key: "cap-reached",
      label: "Cap Reached",
      description:
        "The daily Anthropic cap was exhausted mid-turn. Voice-heavy calls refused; visitor saw the CapReached card.",
    },
    {
      key: "rate-limit",
      label: "Rate Limit",
      description:
        "The visitor's IP exceeded today's turn / audit allowance.",
    },
  ];

  const buckets: NodeBucket[] = PHASES.map((p) => ({
    label: p.label,
    node: p.key,
    description: p.description,
    messages: toMessages(messages.filter((m) => m.emittedByNode === p.key)),
    modelCalls: toModelCalls(modelCalls.filter((c) => c.node === p.key)),
    uiActions: toUiActions(filterUiActionsByNode(uiActions, modelCalls, messages, p.key)),
  }));
  for (const t of TERMINAL_PHASES) {
    const ran =
      modelCalls.some((c) => c.node === t.key) ||
      messages.some((m) => m.emittedByNode === t.key);
    if (ran) {
      buckets.push({
        label: t.label,
        node: t.key,
        description: t.description,
        messages: toMessages(messages.filter((m) => m.emittedByNode === t.key)),
        modelCalls: toModelCalls(modelCalls.filter((c) => c.node === t.key)),
        uiActions: toUiActions([]),
      });
    }
  }

  // Totals across the whole pipeline — useful header stat.
  const totalLatencyMs = modelCalls.reduce(
    (sum, c) => sum + (c.latencyMs ?? 0),
    0,
  );
  const totalCostUsd = modelCalls.reduce((sum, c) => sum + c.costUsd, 0);

  // Diagram source — interleave messages + model calls + ui actions in
  // chronological order so the visual matches the actual sequence.
  const diagramEvents: DiagramSessionEvent[] = [
    ...messages.map(
      (m): DiagramSessionEvent => ({
        kind: "message",
        ts: m.ts,
        node: m.emittedByNode,
        role: m.role,
      }),
    ),
    ...modelCalls.map(
      (c): DiagramSessionEvent => ({
        kind: "model_call",
        ts: c.ts,
        node: c.node,
        provider: c.provider,
        purpose: c.purpose,
        latencyMs: c.latencyMs,
        wasBlocked: c.wasBlocked,
      }),
    ),
    ...uiActions.map(
      (u): DiagramSessionEvent => ({
        kind: "ui_action",
        ts: u.ts,
        // ui_actions don't store the originating node directly — derive it
        // from the action type via the same map the phase cards use.
        node: phaseForActionType(u.actionType),
        actionType: u.actionType,
      }),
    ),
  ];
  const diagramSource = buildDiagram({ sessionId: id, events: diagramEvents });

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/sessions/${id}`}
          className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink"
        >
          ← Timeline
        </Link>
        <h1 className="font-display text-2xl font-semibold text-ink">Flow</h1>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {session.id}
        </p>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 pt-2 text-xs text-ink-soft">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Started
            </dt>
            <dd>{new Date(session.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Total model latency
            </dt>
            <dd>{formatMs(totalLatencyMs)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Total Claude cost
            </dt>
            <dd>${totalCostUsd.toFixed(4)}</dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Terminal phase
            </dt>
            <dd>{session.terminalNode ?? "—"}</dd>
          </div>
        </dl>
      </header>

      <section className="space-y-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Sequence diagram (live data for this session)
        </h2>
        <MermaidDiagram
          source={diagramSource}
          caption="Each arrow is a real event from this session. Greyed-out actors got no messages — that node never ran. Crossed arrows (X) indicate blocked / failed calls (e.g. Playwright Chromium missing, PSI rate-limited)."
        />
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Phase breakdown
        </h2>
        <ol className="space-y-2">
          {buckets.map((bucket, i) => (
            <li key={bucket.node} className="relative">
              <NodeCard bucket={bucket} />
              {i < buckets.length - 1 ? (
                <div className="my-1 flex justify-center" aria-hidden="true">
                  <span className="font-mono text-base text-ink-muted/60">↓</span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * UI actions live in `ui_actions_emitted` with no explicit node column —
 * we map the action TYPE back to the phase that emits it. Same lookup
 * the phase cards use; kept here so the diagram and the cards agree.
 */
function phaseForActionType(actionType: string): string {
  const map: Record<string, string> = {
    KeepAndBuildOn: "audit",
    AuditFindings: "audit",
    MaturityChart: "strategy",
    ThemesGrid: "strategy",
    RoadmapWidget: "strategy",
    SolutionMap: "solution-mapping",
    TechStackReco: "solution-mapping",
    LeadGenForm: "output",
    CapReached: "cap-reached",
    RateLimitReached: "rate-limit",
    DebugAction: "discovery",
  };
  return map[actionType] ?? "discovery";
}

// ---------------------------------------------------------------------------
// Per-phase card
// ---------------------------------------------------------------------------

function NodeCard({ bucket }: { bucket: NodeBucket }) {
  const ran =
    bucket.messages.length > 0 ||
    bucket.modelCalls.length > 0 ||
    bucket.uiActions.length > 0;

  const phaseLatency = bucket.modelCalls.reduce(
    (sum, c) => sum + (c.latencyMs ?? 0),
    0,
  );
  const phaseCost = bucket.modelCalls.reduce((sum, c) => sum + c.costUsd, 0);

  return (
    <article
      className={cn(
        "rounded-xl border p-4",
        ran
          ? "border-paper-edge bg-paper"
          : "border-paper-edge/50 bg-paper-soft/40 opacity-60",
      )}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-sm font-semibold text-ink">
            {bucket.label}
          </h2>
          <code className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {bucket.node}
          </code>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {ran ? (
            <>
              <span>{formatMs(phaseLatency)}</span>
              {phaseCost > 0 ? <span>${phaseCost.toFixed(4)}</span> : null}
            </>
          ) : (
            <span>Did not run</span>
          )}
        </div>
      </header>

      <p className="mt-1 text-xs text-ink-soft">{bucket.description}</p>

      {bucket.modelCalls.length > 0 ? (
        <section className="mt-3">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            External calls
          </h3>
          <ul className="mt-1.5 space-y-1">
            {bucket.modelCalls.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <div className="flex items-baseline gap-2 truncate">
                  <ProviderTag provider={c.provider} />
                  <code className="truncate font-mono text-ink">{c.model}</code>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {c.purpose}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-muted">
                  {c.inputTokens != null && c.outputTokens != null ? (
                    <span>
                      in {c.inputTokens} · out {c.outputTokens}
                    </span>
                  ) : null}
                  <span>{formatMs(c.latencyMs)}</span>
                  {c.costUsd > 0 ? <span>${c.costUsd.toFixed(4)}</span> : null}
                  {c.wasBlocked ? (
                    <span className="rounded-full bg-severity-critical/15 px-1.5 text-[10px] text-severity-critical">
                      blocked
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {bucket.uiActions.length > 0 ? (
        <section className="mt-3">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Canvas actions emitted
          </h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {bucket.uiActions.map((u) => (
              <li
                key={u.id}
                className="rounded-full bg-ink/5 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-ink-soft"
              >
                {u.actionType}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {bucket.messages.length > 0 ? (
        <section className="mt-3">
          <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Assistant turn
          </h3>
          {bucket.messages.map((m) => (
            <p
              key={m.id}
              className="mt-1 text-xs leading-relaxed text-ink-soft line-clamp-4"
            >
              {m.content}
            </p>
          ))}
        </section>
      ) : null}
    </article>
  );
}

function ProviderTag({ provider }: { provider: string }) {
  const styles: Record<string, string> = {
    anthropic: "bg-violet-100 text-violet-900",
    ollama: "bg-emerald-100 text-emerald-900",
    "google-psi": "bg-blue-100 text-blue-900",
    playwright: "bg-amber-100 text-amber-900",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        styles[provider] ?? "bg-ink/10 text-ink-soft",
      )}
    >
      {provider}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers / coercion
// ---------------------------------------------------------------------------

function toMessages<T extends { id: string; role: string; content: string }>(
  rows: T[],
): T[] {
  return rows.filter((m) => m.role !== "user");
}

function toModelCalls<
  T extends {
    id: string;
    provider: string;
    model: string;
    purpose: string;
    latencyMs: number | null;
    costUsd: number;
    inputTokens: number | null;
    outputTokens: number | null;
    wasBlocked: boolean;
  },
>(rows: T[]): T[] {
  return rows;
}

function toUiActions<T extends { id: string; actionType: string }>(
  rows: T[],
): T[] {
  return rows;
}

/**
 * UI actions are emitted with a node tag that lives inside the JSON
 * payload — but the column we have in the read query is just actionType.
 * We approximate "which node emitted this action" by mapping action types
 * onto their canonical phase. The lookup table is small and intent-driven.
 */
function filterUiActionsByNode<
  U extends { id: string; actionType: string; ts: string },
  C extends { ts: string; node: string | null },
  M extends { ts: string; emittedByNode: string | null },
>(
  uiActions: U[],
  _modelCalls: C[],
  _messages: M[],
  phase: string,
): U[] {
  const phaseOf: Record<string, string> = {
    KeepAndBuildOn: "audit",
    AuditFindings: "audit",
    MaturityChart: "strategy",
    ThemesGrid: "strategy",
    RoadmapWidget: "strategy",
    SolutionMap: "solution-mapping",
    TechStackReco: "solution-mapping",
    LeadGenForm: "output",
    CapReached: "cap-reached",
    RateLimitReached: "rate-limit",
    DebugAction: "discovery",
  };
  return uiActions.filter((u) => (phaseOf[u.actionType] ?? "discovery") === phase);
}

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
