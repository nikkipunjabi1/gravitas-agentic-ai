import { z } from "zod";

/**
 * UIAction — the Generative Canvas wire contract.
 *
 * The agent runtime emits these over the same SSE stream the chat pane
 * consumes. The canvas frontend parses each action, looks it up in the
 * registry, and mounts the matching component.
 *
 * THREE INVARIANTS (do not break):
 *   1. Typed — every action is a discriminated-union member, validated by
 *      this zod schema before it reaches a component.
 *   2. Self-sufficient — components render from `action.data` alone. No
 *      fetching, no globals, no implicit context.
 *   3. Deterministic — same payload → same render. No `Date.now()`, no
 *      randomness inside components.
 *
 * Every action carries `version: z.literal(1)`. When a payload shape
 * changes, bump the version and keep the old branch in the union for one
 * release. Components check `action.version` before rendering.
 *
 * Source of truth: docs/UI_CONTRACT.md. When you add a new branch here,
 * update that doc and add the component + registry entry in the same PR.
 */

// ---------------------------------------------------------------------------
// Shared enums — kept narrow so a typo at a callsite is a compile error.
// ---------------------------------------------------------------------------

export const Lens = z.enum([
  "usability", // D1 — Nielsen heuristics
  "user-needs", // D2 — framework-inferred goal coverage
  "conversion", // D3 — CTA / decision content / trust signals
  "design-execution", // D4 — accessibility, mobile, perf, coherence
]);
export type Lens = z.infer<typeof Lens>;

export const GravitasService = z.enum([
  "experience-strategy-design",
  "product-design-engineering",
  "service-design-operations",
  "ai-data-automation",
  "capability-enablement",
]);
export type GravitasService = z.infer<typeof GravitasService>;

export const FindingCategory = z.enum([
  "ux",
  "performance",
  "accessibility",
  "semantic",
  "design-system",
  "ai-readiness",
  "content",
  "mobile",
  "i18n",
  "trust",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const RoadmapGroupLabel = z.enum([
  "Quick wins",
  "Next 90 days",
  "6–12 months",
  "Must",
  "Should",
  "Could",
]);
export type RoadmapGroupLabel = z.infer<typeof RoadmapGroupLabel>;

// ---------------------------------------------------------------------------
// Discriminated union — UIAction
// ---------------------------------------------------------------------------

/**
 * AuditFindings — Four-Lens-tagged findings. Title is the issue, not the
 * fix (the fix lives in the Roadmap item). See docs/BRANDING.md → Findings
 * convention.
 */
const AuditFindings = z.object({
  type: z.literal("AuditFindings"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    findings: z.array(
      z.object({
        id: z.string(),
        lens: Lens,
        category: FindingCategory,
        severity: Severity,
        title: z.string().max(80), // ≤ 10 words
        detail: z.string().max(360), // ≤ 60 words
        gravitasService: GravitasService.nullable(),
      }),
    ),
  }),
});

/**
 * MaturityChart — Four-Lens radar. Each axis has a raw lens score and a
 * normalized 0–10 value (for radar geometry). Total /100. Target is the
 * optional post-engagement aspiration ("a typical target is 75/100").
 */
const MaturityChart = z.object({
  type: z.literal("MaturityChart"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    axes: z
      .array(
        z.object({
          label: z.enum([
            "Usability Standards", // D1, raw /30
            "User Needs", // D2, raw /20
            "Conversion", // D3, raw /30
            "Design Execution", // D4, raw /20
          ]),
          normalizedScore: z.number().min(0).max(10),
          rawScore: z.number(),
          maxScore: z.union([z.literal(20), z.literal(30)]),
          rationale: z.string().max(200),
        }),
      )
      .length(4),
    totalScore: z.number().min(0).max(100),
    targetScore: z.number().min(0).max(100).nullable(),
  }),
});

/**
 * RoadmapWidget — two labelling modes:
 *   "horizons" — time-based ("Quick wins" / "Next 90 days" / "6–12 months")
 *   "priority" — Gravitas audit convention ("Must" / "Should" / "Could")
 * The agent picks one mode per emission; the canvas renders the labels it's
 * given. Exactly three groups, ≤ 6 items each.
 */
const RoadmapWidget = z.object({
  type: z.literal("RoadmapWidget"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    mode: z.enum(["horizons", "priority"]),
    groups: z
      .array(
        z.object({
          label: RoadmapGroupLabel,
          items: z
            .array(
              z.object({
                title: z.string().max(80),
                why: z.string().max(240),
                gravitasService: GravitasService,
              }),
            )
            .max(6),
        }),
      )
      .length(3),
  }),
});

/**
 * SolutionMap — visitor phrasing ↔ Gravitas service, with optional case-study
 * reference. Never invent a case study — `caseStudyRef` is nullable for a
 * reason.
 */
const SolutionMap = z.object({
  type: z.literal("SolutionMap"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    mappings: z.array(
      z.object({
        visitorPhrase: z.string().max(160),
        service: GravitasService,
        rationale: z.string().max(240),
        caseStudyRef: z.string().nullable(),
      }),
    ),
  }),
});

/** TechStackReco — tech-debt / modernization callouts (Phase 2). */
const TechStackReco = z.object({
  type: z.literal("TechStackReco"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    currentSignals: z.array(z.string()).max(8),
    recommended: z.array(
      z.object({
        layer: z.string(),
        choice: z.string(),
        rationale: z.string().max(200),
      }),
    ),
  }),
});

/** LeadGenForm — Phase 2. Posts to Supabase via a typed action. */
const LeadGenForm = z.object({
  type: z.literal("LeadGenForm"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    headline: z.string().max(120),
    fields: z.array(z.enum(["name", "email", "company", "role", "phone"])).min(2),
    submitLabel: z.string().max(40),
  }),
});

/** ExecutiveBriefDownload — Phase 3. Signed URL to a generated PDF. */
const ExecutiveBriefDownload = z.object({
  type: z.literal("ExecutiveBriefDownload"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    title: z.string().max(120),
    pageCount: z.number().int().positive(),
    downloadUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  }),
});

/**
 * DailyCapReached — global $50/day cap was hit. Captures an email into the
 * waitlist. Distinct from RateLimitReached (per-IP quota).
 */
const DailyCapReached = z.object({
  type: z.literal("DailyCapReached"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    headline: z.string().max(120),
    body: z.string().max(400),
    emailFieldLabel: z.string().max(60),
    submitLabel: z.string().max(40),
    sessionId: z.string().uuid(),
    intendedUrl: z.string().url().nullable(),
  }),
});

/**
 * KeepAndBuildOn — positive findings, rendered BEFORE critique per the
 * Gravitas methodology. 2–4 substantive strengths + ≤ 5 short bullets.
 */
const KeepAndBuildOn = z.object({
  type: z.literal("KeepAndBuildOn"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    strengths: z
      .array(
        z.object({
          title: z.string().max(80),
          detail: z.string().max(240),
          lens: Lens,
        }),
      )
      .min(2)
      .max(4),
    alsoWorking: z.array(z.string().max(120)).max(5).default([]),
  }),
});

/** ThemesGrid — 4–6 cross-cutting patterns that span lenses. */
const ThemesGrid = z.object({
  type: z.literal("ThemesGrid"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    themes: z
      .array(
        z.object({
          title: z.string().max(80),
          body: z.string().max(280),
        }),
      )
      .min(4)
      .max(6),
  }),
});

/**
 * RateLimitReached — per-IP daily quota exhausted (chat turns OR audits).
 * NO email capture — this is anti-abuse, not lead capture.
 */
const RateLimitReached = z.object({
  type: z.literal("RateLimitReached"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    reason: z.enum(["turns", "audits"]),
    headline: z.string().max(120),
    body: z.string().max(400),
    remainingResetIn: z.string().max(60), // "in 6 hours" — human-readable
  }),
});

/**
 * DebugAction — Phase 0 smoke component. Renders the payload as JSON.
 * Useful for end-to-end stream verification before any real action lands.
 */
const DebugAction = z.object({
  type: z.literal("DebugAction"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.unknown(),
});

export const UIAction = z.discriminatedUnion("type", [
  AuditFindings,
  MaturityChart,
  RoadmapWidget,
  SolutionMap,
  TechStackReco,
  LeadGenForm,
  ExecutiveBriefDownload,
  DailyCapReached,
  KeepAndBuildOn,
  ThemesGrid,
  RateLimitReached,
  DebugAction,
]);

export type UIAction = z.infer<typeof UIAction>;
export type UIActionType = UIAction["type"];
export type UIActionOf<K extends UIActionType> = Extract<UIAction, { type: K }>;

/**
 * Convenience: every action type in a flat array, useful for tests and the
 * admin panel's filter dropdowns.
 */
export const UI_ACTION_TYPES: readonly UIActionType[] = [
  "AuditFindings",
  "MaturityChart",
  "RoadmapWidget",
  "SolutionMap",
  "TechStackReco",
  "LeadGenForm",
  "ExecutiveBriefDownload",
  "DailyCapReached",
  "KeepAndBuildOn",
  "ThemesGrid",
  "RateLimitReached",
  "DebugAction",
] as const;
