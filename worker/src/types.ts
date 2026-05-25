import { z } from "zod";

/**
 * AuditResult — the JSON the worker returns from POST /crawl.
 *
 * Shape mirrors what the Audit agent node consumes via the `crawl_url` tool
 * (docs/AGENTS.md). The categories below align with the Four-Lens framework
 * (docs/BRANDING.md) and the FindingCategory enum in src/canvas/schema.ts.
 *
 * Phase 0: every value is a stub marker. The route still returns this exact
 * shape so the Phase 1 Audit node can be wired without changing the contract.
 *
 * Phase 1: Playwright + Lighthouse + Cheerio fill the real values. The schema
 * is the contract; replace the body of runCrawl(), not the schema.
 *
 * If the agent app eventually imports this type, we can either:
 *   (a) re-declare the zod schema in src/agents/ (current plan — workspaces
 *       not shared at the type level), or
 *   (b) lift to a shared @gravitas/contracts package (deferred to backlog).
 */

export const CrawlRequest = z.object({
  /** Visitor-submitted URL. Sanitised here before being handed to the crawler. */
  url: z.string().url().max(2048),
  /** Optional session id from the Next.js side — flows into worker logs. */
  sessionId: z.string().uuid().optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequest>;

export const Performance = z.object({
  /** Largest Contentful Paint — milliseconds. */
  lcpMs: z.number().nullable(),
  /** First Contentful Paint — milliseconds. */
  fcpMs: z.number().nullable(),
  /** Time to First Byte — milliseconds. */
  ttfbMs: z.number().nullable(),
  /** Cumulative Layout Shift — unitless score. */
  cls: z.number().nullable(),
});
export type Performance = z.infer<typeof Performance>;

export const Accessibility = z.object({
  /** Lighthouse a11y score 0–100. */
  score: z.number().min(0).max(100).nullable(),
  /** Distinct issue categories observed. Stub list in Phase 0. */
  issues: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type Accessibility = z.infer<typeof Accessibility>;

export const Semantic = z.object({
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  /** Counts of h1..h6. */
  headingCounts: z.record(z.string(), z.number().int().nonnegative()),
  /** JSON-LD blocks detected. */
  structuredDataTypes: z.array(z.string()),
  langAttribute: z.string().nullable(),
});
export type Semantic = z.infer<typeof Semantic>;

export const DesignSignals = z.object({
  /** Approximate count of distinct button variants. */
  buttonVariants: z.number().int().nonnegative(),
  /** Approximate count of distinct heading sizes. */
  headingSizes: z.number().int().nonnegative(),
  /** Whether RTL handling is present (dir="rtl" or per-element). */
  rtlObserved: z.boolean(),
});
export type DesignSignals = z.infer<typeof DesignSignals>;

export const AIReadiness = z.object({
  hasSitemap: z.boolean(),
  hasRobotsTxt: z.boolean(),
  hasOpenGraph: z.boolean(),
  /** Approximate "machine readable" score 0–1. */
  score: z.number().min(0).max(1).nullable(),
});
export type AIReadiness = z.infer<typeof AIReadiness>;

export const ContentArchitecture = z.object({
  /** Total visible word count, before stripping nav/footer. */
  wordCount: z.number().int().nonnegative(),
  /** Number of top-level navigation links. */
  navLinkCount: z.number().int().nonnegative(),
  /** True if a clear primary CTA was detected above the fold. */
  primaryCtaAboveFold: z.boolean().nullable(),
});
export type ContentArchitecture = z.infer<typeof ContentArchitecture>;

export const AuditResult = z.object({
  /** Echoed back from the request so callers can pair response→request. */
  url: z.string().url(),
  /** ISO timestamp the crawl started. */
  crawledAt: z.string().datetime(),
  /** Wall-clock duration end-to-end. */
  durationMs: z.number().int().nonnegative(),
  /** Phase 0 marker. Phase 1 replaces with the engine name + version. */
  engine: z.object({
    name: z.string(), // "phase0-stub" → "playwright+lighthouse"
    version: z.string(),
  }),
  performance: Performance,
  accessibility: Accessibility,
  semantic: Semantic,
  designSignals: DesignSignals,
  aiReadiness: AIReadiness,
  contentArchitecture: ContentArchitecture,
  /** Phase 0 flag — present so the agent node can warn loudly if it ever
   *  receives a stub in production. Removed once Phase 1 lands. */
  __phase: z.literal("stub").nullable(),
});
export type AuditResult = z.infer<typeof AuditResult>;

export const ErrorResponse = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
