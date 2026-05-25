import { z } from "zod";
import { Lens, GravitasService, FindingCategory, Severity } from "@/canvas/schema";

/**
 * SessionState — the single object that flows through the LangGraph state
 * machine.
 *
 * Why a zod schema and not just a TS interface:
 *   - State persists across turns (Phase 2 swap: Supabase checkpointer).
 *     Deserialising trusted-but-stale state needs runtime validation.
 *   - The agent emits state-derived UIActions; we want zod to catch the bug
 *     where a node forgets to set a required field BEFORE it leaks to the
 *     canvas as `null`.
 *
 * Naming intent:
 *   - `phase` is the node we're currently in (or just completed) — used by
 *     the graph's conditional edges to route.
 *   - `uiActionsEmitted` is a list of action IDs we've already pushed; it
 *     lets a re-entered node know "did I already emit MaturityChart?" so we
 *     don't double-emit on graph retries.
 *
 * docs/AGENTS.md → State.
 */

// ---------------------------------------------------------------------------
// Visitor context
// ---------------------------------------------------------------------------

export const VisitorContext = z.object({
  industry: z.string().nullable(),
  role: z.string().nullable(),
  /** The named problem in the visitor's own words. Quoted by Strategy. */
  namedProblem: z.string().nullable(),
  /** The audited URL — Audit only fires if this is set. */
  submittedUrl: z.string().url().nullable(),
});
export type VisitorContext = z.infer<typeof VisitorContext>;

// ---------------------------------------------------------------------------
// Chat message
// ---------------------------------------------------------------------------

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  /** Which node emitted the message — null for visitor turns. */
  emittedByNode: z
    .enum(["discovery", "audit", "strategy", "solution-mapping", "output", "cap-reached"])
    .nullable(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------------------------------------------------------------------------
// Audit result — shape comes from the worker. Re-declared here so the agent
// has a typed reference without depending on the worker workspace.
// (Phase 2 backlog: hoist to a shared @gravitas/contracts package.)
// ---------------------------------------------------------------------------

export const AuditFinding = z.object({
  id: z.string(),
  lens: Lens,
  category: FindingCategory,
  severity: Severity,
  title: z.string().max(80),
  detail: z.string().max(360),
  gravitasService: GravitasService.nullable(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

export const AuditResult = z.object({
  url: z.string().url(),
  crawledAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  engine: z.object({ name: z.string(), version: z.string() }),
  performance: z.object({
    lcpMs: z.number().nullable(),
    fcpMs: z.number().nullable(),
    ttfbMs: z.number().nullable(),
    cls: z.number().nullable(),
  }),
  accessibility: z.object({
    score: z.number().min(0).max(100).nullable(),
    issues: z.array(
      z.object({
        rule: z.string(),
        severity: Severity,
        count: z.number().int().nonnegative(),
      }),
    ),
  }),
  semantic: z.object({
    title: z.string().nullable(),
    metaDescription: z.string().nullable(),
    headingCounts: z.record(z.string(), z.number().int().nonnegative()),
    structuredDataTypes: z.array(z.string()),
    langAttribute: z.string().nullable(),
  }),
  designSignals: z.object({
    buttonVariants: z.number().int().nonnegative(),
    headingSizes: z.number().int().nonnegative(),
    rtlObserved: z.boolean(),
  }),
  aiReadiness: z.object({
    hasSitemap: z.boolean(),
    hasRobotsTxt: z.boolean(),
    hasOpenGraph: z.boolean(),
    score: z.number().min(0).max(1).nullable(),
  }),
  contentArchitecture: z.object({
    wordCount: z.number().int().nonnegative(),
    navLinkCount: z.number().int().nonnegative(),
    primaryCtaAboveFold: z.boolean().nullable(),
  }),
  /** "stub" only in Phase 0; null once the real crawler ran. */
  __phase: z.literal("stub").nullable(),
  /** Agent-derived: findings tagged from raw signals. Populated by Audit node. */
  findings: z.array(AuditFinding).default([]),
});
export type AuditResult = z.infer<typeof AuditResult>;

// ---------------------------------------------------------------------------
// Strategy result
// ---------------------------------------------------------------------------

export const MaturityAxis = z.object({
  label: z.enum([
    "Usability Standards",
    "User Needs",
    "Conversion",
    "Design Execution",
  ]),
  normalizedScore: z.number().min(0).max(10),
  rawScore: z.number(),
  maxScore: z.union([z.literal(20), z.literal(30)]),
  rationale: z.string().max(200),
});
export type MaturityAxis = z.infer<typeof MaturityAxis>;

export const RoadmapItem = z.object({
  title: z.string().max(80),
  why: z.string().max(240),
  gravitasService: GravitasService,
});
export type RoadmapItem = z.infer<typeof RoadmapItem>;

export const StrategyResult = z.object({
  maturity: z.object({
    axes: z.array(MaturityAxis).length(4),
    totalScore: z.number().min(0).max(100),
    targetScore: z.number().min(0).max(100).nullable(),
  }),
  roadmap: z.object({
    mode: z.enum(["horizons", "priority"]),
    must: z.array(RoadmapItem).max(6),
    should: z.array(RoadmapItem).max(6),
    could: z.array(RoadmapItem).max(6),
  }),
  themes: z.array(z.object({ title: z.string().max(80), body: z.string().max(280) })),
  keepAndBuildOn: z.array(z.object({ title: z.string().max(80), detail: z.string().max(240), lens: Lens })).default([]),
});
export type StrategyResult = z.infer<typeof StrategyResult>;

// ---------------------------------------------------------------------------
// Solution map
// ---------------------------------------------------------------------------

export const SolutionMap = z.object({
  mappings: z.array(
    z.object({
      visitorPhrase: z.string().max(160),
      service: GravitasService,
      rationale: z.string().max(240),
      caseStudyRef: z.string().nullable(),
    }),
  ),
});
export type SolutionMap = z.infer<typeof SolutionMap>;

// ---------------------------------------------------------------------------
// SessionState — the full graph state
// ---------------------------------------------------------------------------

export const SessionPhase = z.enum([
  "discovery",
  "audit",
  "strategy",
  "mapping",
  "output",
  "cap-reached",
  "done",
]);
export type SessionPhase = z.infer<typeof SessionPhase>;

export const SessionState = z.object({
  sessionId: z.string().uuid(),
  visitor: VisitorContext,
  messages: z.array(ChatMessage),
  audit: AuditResult.nullable(),
  strategy: StrategyResult.nullable(),
  solutionMap: SolutionMap.nullable(),
  uiActionsEmitted: z.array(z.string()),
  phase: SessionPhase,
});
export type SessionState = z.infer<typeof SessionState>;

/** Build a fresh state for a new session, with no visitor info yet. */
export function newSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    visitor: {
      industry: null,
      role: null,
      namedProblem: null,
      submittedUrl: null,
    },
    messages: [],
    audit: null,
    strategy: null,
    solutionMap: null,
    uiActionsEmitted: [],
    phase: "discovery",
  };
}
