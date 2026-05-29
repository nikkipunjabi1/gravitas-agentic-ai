import "server-only";
import { END, START, StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";
import { runDiscovery } from "./nodes/discovery";
import { runAudit } from "./nodes/audit";
import { runStrategy } from "./nodes/strategy";
import { runSolutionMapping } from "./nodes/solution-mapping";
import { runOutput } from "./nodes/output";
import { runCapReached } from "./nodes/cap-reached";
import type { AuditResult, SessionState, StrategyResult, SolutionMap, VisitorContext } from "./state";
import { DailyCapExceeded } from "@/lib/models";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import { appendMessage, updateSessionVisitor } from "@/server/sessions";
import { getFeatureFlags } from "@/server/runtime-config";
import type { Message as RouterMessage } from "@/lib/models";

/**
 * Phase 1.4 — the full agent graph.
 *
 *   START
 *     └─► Discovery ─┬─► (no URL or not ready)            ─► END
 *                    ├─► (URL + not yet audited)          ─► Audit ─┐
 *                    └─► (cap already tripped)            ─► CapReached ─► END
 *                                                                   │
 *                              ┌────────────────────────────────────┘
 *                              ▼
 *                          ┌─ rateLimited ─► END
 *                          │  cap-reached  ─► CapReached
 *                          └─ proceed      ─► Strategy
 *                                                  │
 *                                                  ▼
 *                                          ┌─ cap-reached ─► CapReached
 *                                          └─ proceed     ─► SolutionMapping
 *                                                                 │
 *                                                                 ▼
 *                                                              Output ─► END
 *
 * Checkpointing: in-memory MemorySaver, keyed by thread_id (= sessionId).
 * State persists across turns within the same process — visitor, audit and
 * strategy stick so a follow-up turn doesn't re-audit. Phase 2 swap target:
 * a Supabase-backed checkpointer.
 *
 * DailyCapExceeded handling: any node may throw DailyCapExceeded when
 * router.stream/complete refuses a voice-heavy call. We catch INSIDE each
 * downstream-routing node-wrapper and flip `capReached` in state — the
 * conditional edges then route to CapReached. Saves us a try/catch wrapper
 * at every callsite of the router.
 */

// ---------------------------------------------------------------------------
// State annotation
// ---------------------------------------------------------------------------

const replace = <T>(_curr: T, next: T): T => next;

const GraphState = Annotation.Root({
  sessionId: Annotation<string>(),
  ipHash: Annotation<string>(),
  visitor: Annotation<VisitorContext>({
    value: (curr, next) => ({ ...curr, ...next }),
    default: () => ({
      industry: null,
      role: null,
      namedProblem: null,
      submittedUrl: null,
    }),
  }),
  userMessage: Annotation<string>(),
  // history is per-turn input from the chat route; replace semantics (caller
  // supplies the full prior conversation on each invoke).
  history: Annotation<RouterMessage[]>({
    value: replace,
    default: () => [],
  }),
  audit: Annotation<AuditResult | null>({ value: replace, default: () => null }),
  strategy: Annotation<StrategyResult | null>({ value: replace, default: () => null }),
  solutionMap: Annotation<SolutionMap | null>({ value: replace, default: () => null }),
  assistantText: Annotation<string>({ value: replace, default: () => "" }),
  capReached: Annotation<boolean>({ value: replace, default: () => false }),
  rateLimitedAudit: Annotation<boolean>({ value: replace, default: () => false }),
  /**
   * P1.18 — populated by the discovery node from getFeatureFlags(). The
   * router edge `routeAfterDiscovery` is sync, so it can't await the
   * settings read itself; we resolve once per turn and pass the result
   * through state.
   */
  featureAuditEnabled: Annotation<boolean>({ value: replace, default: () => true }),
  terminalPhase: Annotation<SessionState["phase"]>({
    value: replace,
    default: () => "discovery",
  }),
});

type GraphStateT = typeof GraphState.State;

// ---------------------------------------------------------------------------
// Runtime context (not in state)
// ---------------------------------------------------------------------------

export interface GraphRuntimeCtx {
  writer: DataStreamWriter;
  signal: AbortSignal | null;
}

interface ConfigurableShape {
  configurable?: { runtime?: GraphRuntimeCtx; thread_id?: string };
}

function getRuntime(config: ConfigurableShape): GraphRuntimeCtx {
  const rt = config.configurable?.runtime;
  if (!rt) {
    throw new Error("graph invoked without runtime context (writer/signal)");
  }
  return rt;
}

// ---------------------------------------------------------------------------
// Node bindings
// ---------------------------------------------------------------------------

async function discoveryNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Promise<Partial<GraphStateT>> {
  const rt = getRuntime(config);
  const featureFlags = await getFeatureFlags();

  try {
    const out = await runDiscovery(
      { writer: rt.writer, sessionId: state.sessionId, signal: rt.signal ?? undefined },
      {
        userMessage: state.userMessage,
        history: state.history,
        visitor: state.visitor,
      },
    );

    // Persistence writes are fire-and-forget — the assistant text has
    // already streamed to the client; the FK chain to sessions.id was
    // satisfied by ensureSession upstream; awaiting only adds Supabase
    // round-trip latency to the turn close.
    void appendMessage({
      sessionId: state.sessionId,
      role: "assistant",
      content: out.assistantText,
      emittedByNode: "discovery",
    }).catch(() => undefined);

    if (Object.keys(out.visitorPatch).length > 0) {
      void updateSessionVisitor({
        sessionId: state.sessionId,
        industry: out.visitorPatch.industry,
        role: out.visitorPatch.role,
        namedProblem: out.visitorPatch.namedProblem,
        submittedUrl: out.visitorPatch.submittedUrl,
      }).catch(() => undefined);
    }

    const mergedVisitor: VisitorContext = { ...state.visitor, ...out.visitorPatch };

    return {
      visitor: mergedVisitor,
      assistantText: out.assistantText,
      terminalPhase: "discovery" as SessionState["phase"],
      featureAuditEnabled: featureFlags.auditEnabled,
    };
  } catch (err) {
    if (err instanceof DailyCapExceeded) {
      return { capReached: true };
    }
    throw err;
  }
}

async function auditNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Promise<Partial<GraphStateT>> {
  const rt = getRuntime(config);
  try {
    const out = await runAudit(
      {
        writer: rt.writer,
        sessionId: state.sessionId,
        ipHash: state.ipHash,
        signal: rt.signal ?? undefined,
      },
      { visitor: state.visitor },
    );

    if (out.assistantText) {
      await appendMessage({
        sessionId: state.sessionId,
        role: "assistant",
        content: out.assistantText,
        emittedByNode: "audit",
      }).catch(() => undefined);
    }

    return {
      audit: out.audit,
      rateLimitedAudit: out.rateLimited,
      assistantText: out.assistantText,
      terminalPhase: "audit" as SessionState["phase"],
    };
  } catch (err) {
    if (err instanceof DailyCapExceeded) {
      return { capReached: true };
    }
    throw err;
  }
}

async function strategyNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Promise<Partial<GraphStateT>> {
  const rt = getRuntime(config);
  try {
    const out = await runStrategy(
      { writer: rt.writer, sessionId: state.sessionId, signal: rt.signal ?? undefined },
      { visitor: state.visitor, audit: state.audit },
    );

    await appendMessage({
      sessionId: state.sessionId,
      role: "assistant",
      content: out.assistantText,
      emittedByNode: "strategy",
    }).catch(() => undefined);

    return {
      strategy: out.strategy,
      assistantText: out.assistantText,
      terminalPhase: "strategy" as SessionState["phase"],
    };
  } catch (err) {
    if (err instanceof DailyCapExceeded) {
      return { capReached: true };
    }
    throw err;
  }
}

async function solutionMappingNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Promise<Partial<GraphStateT>> {
  const rt = getRuntime(config);
  try {
    const out = await runSolutionMapping(
      { writer: rt.writer, sessionId: state.sessionId, signal: rt.signal ?? undefined },
      { visitor: state.visitor, audit: state.audit },
    );

    await appendMessage({
      sessionId: state.sessionId,
      role: "assistant",
      content: out.assistantText,
      emittedByNode: "solution-mapping",
    }).catch(() => undefined);

    return {
      solutionMap: out.solutionMap,
      assistantText: out.assistantText,
      terminalPhase: "mapping" as SessionState["phase"],
    };
  } catch (err) {
    if (err instanceof DailyCapExceeded) {
      return { capReached: true };
    }
    throw err;
  }
}

async function outputNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Promise<Partial<GraphStateT>> {
  const rt = getRuntime(config);
  try {
    const out = await runOutput(
      { writer: rt.writer, sessionId: state.sessionId, signal: rt.signal ?? undefined },
      { visitor: state.visitor, audit: state.audit, strategy: state.strategy },
    );

    await appendMessage({
      sessionId: state.sessionId,
      role: "assistant",
      content: out.assistantText,
      emittedByNode: "output",
    }).catch(() => undefined);

    return {
      assistantText: out.assistantText,
      terminalPhase: "output" as SessionState["phase"],
    };
  } catch (err) {
    if (err instanceof DailyCapExceeded) {
      return { capReached: true };
    }
    throw err;
  }
}

function capReachedNode(
  state: GraphStateT,
  config: ConfigurableShape,
): Partial<GraphStateT> {
  const rt = getRuntime(config);
  const out = runCapReached(
    { writer: rt.writer, sessionId: state.sessionId },
    { visitor: state.visitor },
  );
  // Fire-and-forget — don't await inside a sync node
  void appendMessage({
    sessionId: state.sessionId,
    role: "assistant",
    content: out.assistantText,
    emittedByNode: "cap-reached",
  }).catch(() => undefined);

  return {
    assistantText: out.assistantText,
    terminalPhase: "cap-reached" as SessionState["phase"],
  };
}

// ---------------------------------------------------------------------------
// Conditional edges
// ---------------------------------------------------------------------------

function routeAfterDiscovery(
  state: GraphStateT,
): "do_audit" | "do_cap_reached" | typeof END {
  if (state.capReached) return "do_cap_reached";
  // P1.18 feature flag — admin can disable the entire audit pipeline for
  // a "chatbot only" bespoke deployment. The flag is read async by the
  // discovery node and surfaced via state.featureAuditEnabled so this
  // sync edge function can act on it.
  if (state.featureAuditEnabled === false) return END;
  // Audit when we have a URL AND either (a) we've never audited, or (b) the
  // current URL differs from what we audited last time. The url comparison
  // is what lets a visitor say "now audit a different page" mid-session;
  // without it the checkpointer's prior audit would short-circuit the route.
  if (state.visitor.submittedUrl) {
    const auditedUrl = state.audit?.url ?? null;
    if (!state.audit || auditedUrl !== state.visitor.submittedUrl) {
      return "do_audit";
    }
  }
  return END;
}

function routeAfterAudit(
  state: GraphStateT,
): "do_strategy" | "do_cap_reached" | typeof END {
  if (state.capReached) return "do_cap_reached";
  if (state.rateLimitedAudit) return END;
  if (!state.audit) return END; // crawl failed; stop gracefully
  return "do_strategy";
}

function routeAfterStrategy(
  state: GraphStateT,
): "do_mapping" | "do_cap_reached" {
  if (state.capReached) return "do_cap_reached";
  return "do_mapping";
}

function routeAfterMapping(state: GraphStateT): "do_output" | "do_cap_reached" {
  if (state.capReached) return "do_cap_reached";
  return "do_output";
}

// ---------------------------------------------------------------------------
// Graph build
// ---------------------------------------------------------------------------

function buildGraph() {
  // MemorySaver — Phase 1 in-memory checkpointer keyed by thread_id. Phase 2
  // swap: SupabaseCheckpointer reading/writing to the `agent_checkpoints`
  // table (not yet introduced — Phase 2 migration).
  const checkpointer = new MemorySaver();

  // Node names use a `do_` prefix so they don't collide with state channel
  // names (LangGraph 0.2 forbids overlap — `audit`, `strategy`, etc are
  // state fields). The prefix also reads cleanly in trace logs.
  return new StateGraph(GraphState)
    .addNode("do_discovery", discoveryNode)
    .addNode("do_audit", auditNode)
    .addNode("do_strategy", strategyNode)
    .addNode("do_mapping", solutionMappingNode)
    .addNode("do_output", outputNode)
    .addNode("do_cap_reached", capReachedNode)
    .addEdge(START, "do_discovery")
    .addConditionalEdges("do_discovery", routeAfterDiscovery, {
      do_audit: "do_audit",
      do_cap_reached: "do_cap_reached",
      [END]: END,
    })
    .addConditionalEdges("do_audit", routeAfterAudit, {
      do_strategy: "do_strategy",
      do_cap_reached: "do_cap_reached",
      [END]: END,
    })
    .addConditionalEdges("do_strategy", routeAfterStrategy, {
      do_mapping: "do_mapping",
      do_cap_reached: "do_cap_reached",
    })
    .addConditionalEdges("do_mapping", routeAfterMapping, {
      do_output: "do_output",
      do_cap_reached: "do_cap_reached",
    })
    .addEdge("do_output", END)
    .addEdge("do_cap_reached", END)
    .compile({ checkpointer });
}

let cached: ReturnType<typeof buildGraph> | null = null;
export function getGraph(): ReturnType<typeof buildGraph> {
  if (!cached) cached = buildGraph();
  return cached;
}

// ---------------------------------------------------------------------------
// Public entry — used by /api/chat
// ---------------------------------------------------------------------------

export interface RunTurnInput {
  sessionId: string;
  ipHash: string;
  visitor: VisitorContext;
  history: RouterMessage[];
  userMessage: string;
  writer: DataStreamWriter;
  signal: AbortSignal | null;
}

export interface RunTurnResult {
  visitor: VisitorContext;
  assistantText: string;
  terminalPhase: SessionState["phase"];
  audit: AuditResult | null;
  strategy: StrategyResult | null;
  solutionMap: SolutionMap | null;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const graph = getGraph();
  const finalState = await graph.invoke(
    {
      sessionId: input.sessionId,
      ipHash: input.ipHash,
      // Pass visitor as a SEED only; checkpointer hydrates real value on
      // subsequent turns. The merge reducer makes this idempotent.
      visitor: input.visitor,
      userMessage: input.userMessage,
      history: input.history,
    },
    {
      configurable: {
        thread_id: input.sessionId,
        runtime: { writer: input.writer, signal: input.signal },
      },
    },
  );
  return {
    visitor: finalState.visitor,
    assistantText: finalState.assistantText,
    terminalPhase: finalState.terminalPhase,
    audit: finalState.audit,
    strategy: finalState.strategy,
    solutionMap: finalState.solutionMap,
  };
}
