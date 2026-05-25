import type { AuditResult, AuditFinding } from "./state";
import type { GravitasService } from "@/canvas/schema";

/**
 * Heuristic finding derivation — Phase 1.4.
 *
 * Maps the raw `AuditResult` from the worker into a tagged `AuditFinding[]`
 * shaped for the Four-Lens framework. Pure function; deterministic given
 * input; trivially testable.
 *
 * Phase 2 swap: replace the body with a DeepSeek-R1 reasoning pass over the
 * JSON. The agent code that consumes findings doesn't need to change — only
 * the producer here. Tests will need provider mocks then.
 *
 * Conventions (docs/BRANDING.md → Findings convention):
 *   - title ≤ 10 words, the issue not the fix
 *   - detail ≤ 60 words, why it matters + impact
 *   - severity based on USER IMPACT, not technical complexity
 *   - lens + gravitasService tagged at emission time
 */

interface Rule {
  id: string;
  matches: (audit: AuditResult) => boolean;
  finding: (audit: AuditResult) => Omit<AuditFinding, "id">;
}

const RULES: Rule[] = [
  // ---- D4 Design Execution — performance ---------------------------------
  {
    id: "lcp-slow",
    matches: (a) => typeof a.performance.lcpMs === "number" && a.performance.lcpMs > 4000,
    finding: (a) => ({
      lens: "design-execution",
      category: "performance",
      severity: "high",
      title: "Largest contentful paint above 4 seconds on first visit",
      detail:
        `LCP at ${formatMs(a.performance.lcpMs)}. First-time visitors stare at a partial page long enough that 25% typically bail. ` +
        "Real spend on lower-funnel campaigns is being wasted at the perception step.",
      gravitasService: "product-design-engineering",
    }),
  },
  {
    id: "lcp-borderline",
    matches: (a) =>
      typeof a.performance.lcpMs === "number" &&
      a.performance.lcpMs > 2500 &&
      a.performance.lcpMs <= 4000,
    finding: (a) => ({
      lens: "design-execution",
      category: "performance",
      severity: "medium",
      title: "Largest contentful paint between 2.5 and 4 seconds",
      detail:
        `LCP at ${formatMs(a.performance.lcpMs)}. Google labels this "needs improvement". ` +
        "It's the gap between an acceptable load and an instant one — closeable with image and font hygiene.",
      gravitasService: "product-design-engineering",
    }),
  },
  {
    id: "cls-poor",
    matches: (a) => typeof a.performance.cls === "number" && a.performance.cls > 0.25,
    finding: (a) => ({
      lens: "design-execution",
      category: "performance",
      severity: "medium",
      title: "Layout shifts after first paint cause visible jumpiness",
      detail:
        `Cumulative Layout Shift at ${(a.performance.cls ?? 0).toFixed(2)} (anything above 0.25 is "poor"). ` +
        "Users mis-tap. Carts get abandoned. Often a single un-reserved image or late web-font is responsible.",
      gravitasService: "product-design-engineering",
    }),
  },
  {
    id: "ttfb-slow",
    matches: (a) => typeof a.performance.ttfbMs === "number" && a.performance.ttfbMs > 800,
    finding: (a) => ({
      lens: "design-execution",
      category: "performance",
      severity: "medium",
      title: "Time to first byte is slower than competitors",
      detail:
        `TTFB at ${formatMs(a.performance.ttfbMs)} — the server takes a beat before the page even starts rendering. ` +
        "Usually a hosting or CDN choice, not a frontend problem.",
      gravitasService: "product-design-engineering",
    }),
  },

  // ---- D4 Design Execution — accessibility -------------------------------
  {
    id: "a11y-low",
    matches: (a) =>
      typeof a.accessibility.score === "number" && a.accessibility.score < 70,
    finding: (a) => ({
      lens: "design-execution",
      category: "accessibility",
      severity: "high",
      title: "Accessibility issues that exclude part of the audience",
      detail:
        `Heuristic accessibility score ${a.accessibility.score}/100. ` +
        `Top categories: ${a.accessibility.issues.slice(0, 3).map((i) => i.rule).join(", ") || "structural gaps"}. ` +
        "Beyond compliance, these are also the easiest wins for SEO + AI-readability.",
      gravitasService: "experience-strategy-design",
    }),
  },
  {
    id: "a11y-medium",
    matches: (a) =>
      typeof a.accessibility.score === "number" &&
      a.accessibility.score >= 70 &&
      a.accessibility.score < 90,
    finding: (a) => ({
      lens: "design-execution",
      category: "accessibility",
      severity: "medium",
      title: "Accessibility gaps reduce reach to ~10% of users",
      detail:
        `Heuristic accessibility score ${a.accessibility.score}/100. ` +
        "Mostly fixable in a sprint — missing alt text, label-less inputs, and an absent skip link account for most points lost.",
      gravitasService: "experience-strategy-design",
    }),
  },

  // ---- D1 Usability Standards — page structure ---------------------------
  {
    id: "no-h1",
    matches: (a) => (a.semantic.headingCounts["h1"] ?? 0) === 0,
    finding: () => ({
      lens: "usability",
      category: "semantic",
      severity: "medium",
      title: "Page has no H1, so users + crawlers cannot anchor",
      detail:
        "The H1 is the contract between a page and its visitor: 'this page is about X'. " +
        "Missing one signals to search engines + assistive tech that the page has no primary topic.",
      gravitasService: "experience-strategy-design",
    }),
  },
  {
    id: "multiple-h1",
    matches: (a) => (a.semantic.headingCounts["h1"] ?? 0) > 1,
    finding: (a) => ({
      lens: "usability",
      category: "semantic",
      severity: "low",
      title: "Multiple H1s on a page that should have one",
      detail:
        `Found ${a.semantic.headingCounts["h1"]} H1 elements. Modern SEO is forgiving of this, but it usually signals a copy-pasted hero ` +
        "or template that was never adapted to this page's role.",
      gravitasService: "experience-strategy-design",
    }),
  },

  // ---- D3 Conversion — content + trust ----------------------------------
  {
    id: "thin-content",
    matches: (a) => a.contentArchitecture.wordCount < 80,
    finding: (a) => ({
      lens: "conversion",
      category: "content",
      severity: "high",
      title: "Page has too little content for a visitor to decide on",
      detail:
        `Only ${a.contentArchitecture.wordCount} words of body copy. Decisions need information — pricing, social proof, the answer to "why now". ` +
        "Thin pages convert the visitors who already arrived convinced; everyone else bounces.",
      gravitasService: "experience-strategy-design",
    }),
  },
  {
    id: "no-meta-description",
    matches: (a) => !a.semantic.metaDescription,
    finding: () => ({
      lens: "conversion",
      category: "content",
      severity: "low",
      title: "No meta description shapes search snippet for visitors",
      detail:
        "Without a meta description, search engines pick a sentence at random. " +
        "That random sentence is the first words an organic visitor reads about your brand.",
      gravitasService: "experience-strategy-design",
    }),
  },

  // ---- D2 User Needs — language + structure ------------------------------
  {
    id: "no-lang",
    matches: (a) => !a.semantic.langAttribute,
    finding: () => ({
      lens: "user-needs",
      category: "i18n",
      severity: "low",
      title: "No language attribute on the document",
      detail:
        "Assistive tech reads the page out loud using the wrong pronunciation rules. " +
        "Browsers offer translation prompts that backfire. Two characters in HTML fix it.",
      gravitasService: "product-design-engineering",
    }),
  },

  // ---- D4 Design Execution — design coherence ----------------------------
  {
    id: "many-button-variants",
    matches: (a) => a.designSignals.buttonVariants > 4,
    finding: (a) => ({
      lens: "design-execution",
      category: "design-system",
      severity: "medium",
      title: "Too many button variants on a single page",
      detail:
        `${a.designSignals.buttonVariants} distinct button styles observed. ` +
        "Every variant is a moment the visitor wonders 'is this the same kind of action as the last one?'. " +
        "A design-system pass collapses these to 2-3 intentional roles.",
      gravitasService: "experience-strategy-design",
    }),
  },
  {
    id: "many-heading-sizes",
    matches: (a) => a.designSignals.headingSizes > 5,
    finding: (a) => ({
      lens: "design-execution",
      category: "design-system",
      severity: "low",
      title: "Heading scale is wider than design systems usually support",
      detail:
        `${a.designSignals.headingSizes} distinct heading sizes detected. ` +
        "Type scales over 5 steps stop reading as a scale and start reading as ad-hoc — content authors lose the rule.",
      gravitasService: "experience-strategy-design",
    }),
  },

  // ---- D4 Design Execution — AI-readiness --------------------------------
  {
    id: "no-structured-data",
    matches: (a) => a.semantic.structuredDataTypes.length === 0,
    finding: () => ({
      lens: "design-execution",
      category: "ai-readiness",
      severity: "medium",
      title: "No JSON-LD structured data means AI agents work harder",
      detail:
        "ChatGPT, Perplexity and Google's AI surfaces preferentially cite pages with schema.org markup. " +
        "Without it, your services and case studies get summarised by guess.",
      gravitasService: "ai-data-automation",
    }),
  },
  {
    id: "no-open-graph",
    matches: (a) => !a.aiReadiness.hasOpenGraph,
    finding: () => ({
      lens: "design-execution",
      category: "ai-readiness",
      severity: "low",
      title: "No Open Graph metadata for social + chat link previews",
      detail:
        "Shared links render as a bare URL instead of a card. Slack, LinkedIn, WhatsApp, and ChatGPT plugins all read OG tags.",
      gravitasService: "experience-strategy-design",
    }),
  },
  {
    id: "no-sitemap",
    matches: (a) => !a.aiReadiness.hasSitemap,
    finding: () => ({
      lens: "design-execution",
      category: "ai-readiness",
      severity: "low",
      title: "No sitemap.xml found at the canonical path",
      detail:
        "Crawlers can usually find pages anyway, but missing a sitemap means slower indexation and worse coverage of deeper pages.",
      gravitasService: "product-design-engineering",
    }),
  },
];

/**
 * Apply every rule to the audit and return the matching findings. Severity
 * order: critical > high > medium > low. Within the same severity, rule
 * insertion order is preserved (so the Audit node + canvas show the most
 * impactful issues first per lens).
 */
export function deriveFindings(audit: AuditResult): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const rule of RULES) {
    if (rule.matches(audit)) {
      out.push({ id: rule.id, ...rule.finding(audit) });
    }
  }
  return out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

/**
 * Positive observations — "Keep & Build On" framing per Gravitas methodology.
 * These render BEFORE critique on the canvas. We're calibrated: if the page
 * is genuinely poor, we acknowledge ONE thing and move on rather than invent
 * praise. See docs/BRANDING.md → Strength framing.
 */
export function deriveStrengths(audit: AuditResult): Array<{
  title: string;
  detail: string;
  lens: AuditFinding["lens"];
}> {
  const out: Array<{ title: string; detail: string; lens: AuditFinding["lens"] }> = [];

  if (typeof audit.performance.lcpMs === "number" && audit.performance.lcpMs < 2500) {
    out.push({
      title: "Page paints fast on first visit",
      detail: `LCP at ${formatMs(audit.performance.lcpMs)} — comfortably inside Google's "Good" threshold. Keep this discipline through the redesign.`,
      lens: "design-execution",
    });
  }
  if (typeof audit.accessibility.score === "number" && audit.accessibility.score >= 90) {
    out.push({
      title: "Accessibility fundamentals are in place",
      detail: `Heuristic score ${audit.accessibility.score}/100. The page respects users on assistive tech. Use this as the internal benchmark.`,
      lens: "design-execution",
    });
  }
  if (audit.semantic.structuredDataTypes.length > 0) {
    out.push({
      title: "Structured data lets AI surfaces cite you",
      detail: `JSON-LD detected (${audit.semantic.structuredDataTypes.slice(0, 3).join(", ")}). Pages like this are the ones search engines + LLMs reach for first.`,
      lens: "design-execution",
    });
  }
  if (audit.contentArchitecture.wordCount >= 350) {
    out.push({
      title: "There's enough content for a visitor to actually decide",
      detail: `${audit.contentArchitecture.wordCount} words of body copy — long enough to answer the decision-grade questions without padding.`,
      lens: "conversion",
    });
  }
  if (typeof audit.performance.cls === "number" && audit.performance.cls < 0.05) {
    out.push({
      title: "Layout holds steady as the page finishes loading",
      detail: `CLS at ${audit.performance.cls.toFixed(3)} — visitors don't mis-tap or lose their place. Reserved space for images + fonts is being honoured.`,
      lens: "design-execution",
    });
  }

  // Calibration: 2–4 strengths is the documented range (KeepAndBuildOn
  // schema enforces `min(2)`). Top up with calibrated, honest fallbacks
  // when the page is genuinely weak — never invent praise that isn't there.
  const fallbacks: typeof out = [
    {
      title: "The page exists, renders, and gives us something to work with",
      detail:
        "There's enough here to audit cleanly. The next pass is mostly subtraction and structure — neither requires starting from zero.",
      lens: "usability",
    },
    {
      title: "A single page is a tractable starting place, not the whole problem",
      detail:
        "Auto-audits like this one let the team focus a wider review around the issues that actually move conversion. The hard work is the journey, not this page.",
      lens: "user-needs",
    },
  ];
  let fi = 0;
  while (out.length < 2 && fi < fallbacks.length) {
    const next = fallbacks[fi++];
    if (next) out.push(next);
  }

  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Mapping findings → Gravitas services for SolutionMap.
// ---------------------------------------------------------------------------

const SERVICE_PRIORITY: GravitasService[] = [
  "experience-strategy-design",
  "product-design-engineering",
  "service-design-operations",
  "ai-data-automation",
  "capability-enablement",
];

const SERVICE_LABELS: Record<GravitasService, string> = {
  "experience-strategy-design": "Experience Strategy & Design",
  "product-design-engineering": "Product Design & Engineering",
  "service-design-operations": "Service Design & Operations",
  "ai-data-automation": "AI, Data & Automation",
  "capability-enablement": "Capability & Enablement",
};

export function getServiceLabel(service: GravitasService): string {
  return SERVICE_LABELS[service];
}

/**
 * Group findings by Gravitas service and produce a SolutionMap entry per
 * group. Each entry quotes one finding's title verbatim as the
 * `visitorPhrase` so the canvas shows real language from the audit, not LLM
 * paraphrase.
 */
export function deriveSolutionMappings(
  findings: AuditFinding[],
  namedProblem: string | null,
): Array<{
  visitorPhrase: string;
  service: GravitasService;
  rationale: string;
  caseStudyRef: string | null;
}> {
  const byService = new Map<GravitasService, AuditFinding[]>();
  for (const f of findings) {
    if (!f.gravitasService) continue;
    const arr = byService.get(f.gravitasService);
    if (arr) arr.push(f);
    else byService.set(f.gravitasService, [f]);
  }

  const out: Array<{
    visitorPhrase: string;
    service: GravitasService;
    rationale: string;
    caseStudyRef: string | null;
  }> = [];

  for (const service of SERVICE_PRIORITY) {
    const items = byService.get(service);
    if (!items || items.length === 0) continue;
    // Pick the most severe finding's title as the visitor-shaped phrase.
    const top = items[0];
    if (!top) continue;
    const otherCount = items.length - 1;
    const rationale =
      otherCount > 0
        ? `${otherCount} related finding${otherCount === 1 ? "" : "s"} in this area sit under the same engagement.`
        : `Single-issue focus area on this page. Larger engagement spans personas + the wider site.`;
    out.push({
      visitorPhrase: namedProblem ?? top.title,
      service,
      rationale,
      caseStudyRef: null, // Phase 2: pull from KB when one applies
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityRank(s: AuditFinding["severity"]): number {
  switch (s) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== "number") return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
