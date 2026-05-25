import { describe, it, expect } from "vitest";
import {
  deriveFindings,
  deriveStrengths,
  deriveSolutionMappings,
} from "@/agents/findings";
import type { AuditResult } from "@/agents/state";

/**
 * Phase 1.4 unit tests for the heuristic rule set.
 *
 * Pure-function tests — no provider mocks needed. When Phase 2 swaps the
 * heuristic in for a DeepSeek reasoner, these tests get rewritten to
 * exercise the same input/output contract against the new producer.
 */

function makeAudit(patch: Partial<AuditResult> = {}): AuditResult {
  return {
    url: "https://example.com/",
    crawledAt: "2026-05-21T18:00:00.000Z",
    durationMs: 5000,
    engine: { name: "playwright+cheerio", version: "1.0.0" },
    performance: { lcpMs: 1800, fcpMs: 1600, ttfbMs: 200, cls: 0.02 },
    accessibility: { score: 95, issues: [] },
    semantic: {
      title: "Example",
      metaDescription: "An example page",
      headingCounts: { h1: 1, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
      structuredDataTypes: ["WebPage"],
      langAttribute: "en",
    },
    designSignals: { buttonVariants: 2, headingSizes: 3, rtlObserved: false },
    aiReadiness: { hasSitemap: true, hasRobotsTxt: true, hasOpenGraph: true, score: 1 },
    contentArchitecture: { wordCount: 500, navLinkCount: 8, primaryCtaAboveFold: null },
    __phase: null,
    findings: [],
    ...patch,
  };
}

describe("deriveFindings", () => {
  it("returns no findings for a healthy page", () => {
    const findings = deriveFindings(makeAudit());
    expect(findings).toEqual([]);
  });

  it("flags slow LCP > 4s as high severity, performance, design-execution", () => {
    const findings = deriveFindings(
      makeAudit({ performance: { lcpMs: 5500, fcpMs: 3000, ttfbMs: 200, cls: 0.02 } }),
    );
    const lcp = findings.find((f) => f.id === "lcp-slow");
    expect(lcp).toBeDefined();
    expect(lcp?.severity).toBe("high");
    expect(lcp?.lens).toBe("design-execution");
    expect(lcp?.category).toBe("performance");
    expect(lcp?.gravitasService).toBe("product-design-engineering");
  });

  it("flags missing H1 as medium-severity usability finding", () => {
    const findings = deriveFindings(
      makeAudit({
        semantic: {
          title: "Example",
          metaDescription: "x",
          headingCounts: { h1: 0, h2: 2, h3: 0, h4: 0, h5: 0, h6: 0 },
          structuredDataTypes: [],
          langAttribute: "en",
        },
      }),
    );
    const noH1 = findings.find((f) => f.id === "no-h1");
    expect(noH1).toBeDefined();
    expect(noH1?.lens).toBe("usability");
    expect(noH1?.severity).toBe("medium");
  });

  it("flags thin content (<80 words) as high severity conversion", () => {
    const findings = deriveFindings(
      makeAudit({
        contentArchitecture: { wordCount: 17, navLinkCount: 0, primaryCtaAboveFold: null },
      }),
    );
    const thin = findings.find((f) => f.id === "thin-content");
    expect(thin?.severity).toBe("high");
    expect(thin?.lens).toBe("conversion");
  });

  it("flags too-many button variants as design-execution medium", () => {
    const findings = deriveFindings(
      makeAudit({ designSignals: { buttonVariants: 7, headingSizes: 3, rtlObserved: false } }),
    );
    const b = findings.find((f) => f.id === "many-button-variants");
    expect(b).toBeDefined();
    expect(b?.severity).toBe("medium");
    expect(b?.category).toBe("design-system");
  });

  it("flags missing structured data as ai-readiness medium", () => {
    const findings = deriveFindings(
      makeAudit({
        semantic: {
          title: "Example",
          metaDescription: "x",
          headingCounts: { h1: 1 },
          structuredDataTypes: [],
          langAttribute: "en",
        },
      }),
    );
    const sd = findings.find((f) => f.id === "no-structured-data");
    expect(sd?.category).toBe("ai-readiness");
    expect(sd?.gravitasService).toBe("ai-data-automation");
  });

  it("sorts findings by severity descending", () => {
    const findings = deriveFindings(
      makeAudit({
        performance: { lcpMs: 5500, fcpMs: 3000, ttfbMs: 1200, cls: 0.4 }, // high + medium + medium
        contentArchitecture: { wordCount: 10, navLinkCount: 0, primaryCtaAboveFold: null }, // high
        semantic: {
          title: null,
          metaDescription: null,
          headingCounts: { h1: 0 },
          structuredDataTypes: [],
          langAttribute: null,
        },
      }),
    );
    const sevOrder = findings.map((f) => f.severity);
    const ranks = sevOrder.map((s) => ({ critical: 4, high: 3, medium: 2, low: 1 })[s]);
    // Monotonically non-increasing
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]!);
    }
  });

  it("a11y-low (<70) takes precedence over a11y-medium (70-89)", () => {
    const lo = deriveFindings(makeAudit({ accessibility: { score: 55, issues: [] } }));
    expect(lo.some((f) => f.id === "a11y-low")).toBe(true);
    expect(lo.some((f) => f.id === "a11y-medium")).toBe(false);
  });
});

describe("deriveStrengths", () => {
  it("includes fast-LCP strength for a fast page", () => {
    const out = deriveStrengths(makeAudit({ performance: { lcpMs: 1500, fcpMs: 1000, ttfbMs: 100, cls: 0.01 } }));
    expect(out.some((s) => s.title.toLowerCase().includes("fast"))).toBe(true);
  });

  it("returns at least 2 strengths even for a weak page (calibrated fallback)", () => {
    const out = deriveStrengths(
      makeAudit({
        performance: { lcpMs: 8000, fcpMs: 6000, ttfbMs: 2000, cls: 0.5 },
        accessibility: { score: 40, issues: [] },
        contentArchitecture: { wordCount: 12, navLinkCount: 0, primaryCtaAboveFold: null },
        semantic: {
          title: null,
          metaDescription: null,
          headingCounts: {},
          structuredDataTypes: [],
          langAttribute: null,
        },
      }),
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns more than 4 strengths", () => {
    const out = deriveStrengths(
      makeAudit({
        performance: { lcpMs: 1500, fcpMs: 1000, ttfbMs: 100, cls: 0.01 },
        accessibility: { score: 98, issues: [] },
        contentArchitecture: { wordCount: 800, navLinkCount: 8, primaryCtaAboveFold: null },
      }),
    );
    expect(out.length).toBeLessThanOrEqual(4);
  });
});

describe("deriveSolutionMappings", () => {
  it("groups findings by gravitasService in priority order", () => {
    const audit = makeAudit({
      performance: { lcpMs: 5000, fcpMs: 3000, ttfbMs: 100, cls: 0.01 }, // performance → PDE
      contentArchitecture: { wordCount: 10, navLinkCount: 0, primaryCtaAboveFold: null }, // thin → ESD
    });
    const findings = deriveFindings(audit);
    const mappings = deriveSolutionMappings(findings, "checkout has a 50% drop-off");
    // Both ESD and PDE present, ESD first by priority
    expect(mappings[0]?.service).toBe("experience-strategy-design");
    expect(mappings.find((m) => m.service === "product-design-engineering")).toBeDefined();
  });

  it("uses visitor's namedProblem as visitorPhrase when present", () => {
    const audit = makeAudit({
      contentArchitecture: { wordCount: 10, navLinkCount: 0, primaryCtaAboveFold: null },
    });
    const findings = deriveFindings(audit);
    const mappings = deriveSolutionMappings(findings, "Quoted exactly verbatim");
    expect(mappings[0]?.visitorPhrase).toBe("Quoted exactly verbatim");
  });

  it("falls back to finding title when no namedProblem", () => {
    const audit = makeAudit({
      contentArchitecture: { wordCount: 10, navLinkCount: 0, primaryCtaAboveFold: null },
    });
    const findings = deriveFindings(audit);
    const mappings = deriveSolutionMappings(findings, null);
    expect(mappings[0]?.visitorPhrase).toMatch(/Page has too little content/);
  });

  it("returns an empty array when no findings have a service tag", () => {
    expect(deriveSolutionMappings([], null)).toEqual([]);
  });
});
