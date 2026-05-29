import "server-only";
import { z } from "zod";
import { getServerRouter } from "@/server/model-router";
import { renderUI } from "@/agents/tools/render-ui";
import { kbSearch } from "@/agents/tools/kb-search";
import { DailyCapExceeded, isRouterError } from "@/lib/models";
import {
  getAgentPrompts,
  getBrandingConfig,
  resolvePrompt,
} from "@/server/runtime-config";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type {
  AuditResult,
  StrategyResult,
  VisitorContext,
} from "@/agents/state";
import { GravitasService, Lens } from "@/canvas/schema";

/**
 * Strategy node — Phase 1.4.
 *
 * Synthesises Discovery + Audit into a maturity assessment, a Must/Should/
 * Could roadmap, and 4–6 cross-cutting themes. Uses Claude voice-heavy with
 * a strict JSON-shaped prompt; falls back to a deterministic synthesis from
 * the audit data alone if Claude's output fails to parse.
 *
 * Emits three UIActions in order:
 *   1. MaturityChart  — 4-axis radar
 *   2. ThemesGrid     — 4–6 cross-cutting themes
 *   3. RoadmapWidget  — priority-mode Must/Should/Could
 *
 * Followed by a 3-sentence narration streamed via Claude.
 *
 * Grounding: top-k KB chunks against the visitor's namedProblem (or
 * audit URL, as fallback) so Strategy can cite a case study when one applies
 * (Phase 2 will tighten this — current pass just feeds chunks as system
 * context).
 */

export interface StrategyNodeCtx {
  writer: DataStreamWriter;
  sessionId: string;
  signal?: AbortSignal;
}

export interface StrategyNodeInput {
  visitor: VisitorContext;
  audit: AuditResult | null;
}

export interface StrategyNodeOutput {
  strategy: StrategyResult;
  assistantText: string;
}

// ---------------------------------------------------------------------------
// Strict JSON schema we coerce Claude to produce
// ---------------------------------------------------------------------------

const ClaudeStrategyJson = z.object({
  maturity: z.object({
    axes: z
      .array(
        z.object({
          label: z.enum([
            "Usability Standards",
            "User Needs",
            "Conversion",
            "Design Execution",
          ]),
          rawScore: z.number().min(0).max(30),
          rationale: z.string().max(200),
        }),
      )
      .length(4),
    targetScore: z.number().min(0).max(100).nullable().optional(),
  }),
  roadmap: z.object({
    must: z
      .array(
        z.object({
          title: z.string().max(80),
          why: z.string().max(240),
          gravitasService: GravitasService,
        }),
      )
      .max(6),
    should: z
      .array(
        z.object({
          title: z.string().max(80),
          why: z.string().max(240),
          gravitasService: GravitasService,
        }),
      )
      .max(6),
    could: z
      .array(
        z.object({
          title: z.string().max(80),
          why: z.string().max(240),
          gravitasService: GravitasService,
        }),
      )
      .max(6),
  }),
  themes: z
    .array(
      z.object({
        title: z.string().max(80),
        body: z.string().max(280),
      }),
    )
    .min(4)
    .max(6),
  keepAndBuildOn: z
    .array(
      z.object({
        title: z.string().max(80),
        detail: z.string().max(240),
        lens: Lens,
      }),
    )
    .default([]),
});

type ClaudeStrategyJson = z.infer<typeof ClaudeStrategyJson>;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runStrategy(
  ctx: StrategyNodeCtx,
  input: StrategyNodeInput,
): Promise<StrategyNodeOutput> {
  const router = getServerRouter();

  // ---- Resolve runtime prompts -------------------------------------------
  const [promptOverrides, branding] = await Promise.all([
    getAgentPrompts(),
    getBrandingConfig(),
  ]);
  const jsonPrompt =
    resolvePrompt(promptOverrides.strategyJson, branding) ?? STRATEGY_SYSTEM;
  const narrationPrompt =
    resolvePrompt(promptOverrides.strategyNarration, branding) ?? NARRATION_SYSTEM;

  // ---- KB grounding (best-effort) ----------------------------------------
  const groundingQuery =
    input.visitor.namedProblem?.slice(0, 240) ??
    input.audit?.url ??
    "Gravitas services overview";
  let kbChunks: Awaited<ReturnType<typeof kbSearch>> = [];
  try {
    kbChunks = await kbSearch({
      query: groundingQuery,
      k: 4,
      sessionId: ctx.sessionId,
      node: "strategy",
    });
  } catch {
    // searchKB already swallows internally; this is defence in depth.
  }

  // ---- Compose structured JSON via Claude --------------------------------
  let claudeJson: ClaudeStrategyJson | null = null;
  try {
    claudeJson = await composeClaudeStrategy(router, ctx, input, kbChunks, jsonPrompt);
  } catch (err) {
    if (err instanceof DailyCapExceeded) throw err;
    if (isRouterError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[strategy] router error:", err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("[strategy] composition error", err);
    }
  }

  const strategy: StrategyResult = claudeJson
    ? hydrateFromClaude(claudeJson)
    : deterministicStrategy(input.audit);

  // ---- Emit UIActions ---------------------------------------------------
  renderUI(
    ctx.writer,
    {
      type: "MaturityChart",
      id: crypto.randomUUID(),
      version: 1,
      data: {
        axes: strategy.maturity.axes,
        totalScore: strategy.maturity.totalScore,
        targetScore: strategy.maturity.targetScore,
      },
    },
    { sessionId: ctx.sessionId, node: "strategy" },
  );

  if (strategy.themes.length >= 4) {
    renderUI(
      ctx.writer,
      {
        type: "ThemesGrid",
        id: crypto.randomUUID(),
        version: 1,
        data: {
          themes: strategy.themes.slice(0, 6) as unknown as [
            { title: string; body: string },
            { title: string; body: string },
            { title: string; body: string },
            { title: string; body: string },
            ...{ title: string; body: string }[],
          ],
        },
      },
      { sessionId: ctx.sessionId, node: "strategy" },
    );
  }

  renderUI(
    ctx.writer,
    {
      type: "RoadmapWidget",
      id: crypto.randomUUID(),
      version: 1,
      data: {
        mode: "priority",
        groups: [
          { label: "Must", items: strategy.roadmap.must.slice(0, 6) },
          { label: "Should", items: strategy.roadmap.should.slice(0, 6) },
          { label: "Could", items: strategy.roadmap.could.slice(0, 6) },
        ],
      },
    },
    { sessionId: ctx.sessionId, node: "strategy" },
  );

  // ---- Narration --------------------------------------------------------
  const assistantText = await streamSynthesisNarration(
    router,
    ctx,
    strategy,
    input,
    kbChunks,
    narrationPrompt,
  );

  return { strategy, assistantText };
}

// ---------------------------------------------------------------------------
// Claude composition — strict JSON, single retry
// ---------------------------------------------------------------------------

const STRATEGY_SYSTEM = `You are the Gravitas Transformation Co-Pilot composing a structured strategy report. Output EXACTLY one JSON object — no preamble, no markdown fences, no commentary. The shape:

{
  "maturity": {
    "axes": [
      { "label": "Usability Standards", "rawScore": <0–30>, "rationale": "<≤30 words>" },
      { "label": "User Needs", "rawScore": <0–20>, "rationale": "<≤30 words>" },
      { "label": "Conversion", "rawScore": <0–30>, "rationale": "<≤30 words>" },
      { "label": "Design Execution", "rawScore": <0–20>, "rationale": "<≤30 words>" }
    ],
    "targetScore": <0–100 or null>
  },
  "roadmap": {
    "must":   [ { "title": "<≤10 words>", "why": "<≤40 words>", "gravitasService": "<enum>" }, ... ],
    "should": [ ... up to 6 items ],
    "could":  [ ... up to 6 items ]
  },
  "themes": [
    { "title": "<≤10 words>", "body": "<≤50 words>" }
    ... 4 to 6 items
  ],
  "keepAndBuildOn": [
    { "title": "<≤10 words>", "detail": "<≤40 words>", "lens": "<enum>" }
    ... 0 to 4 items
  ]
}

Calibration (docs/BRANDING.md → Scoring rubric):
- D1 Usability Standards (out of 30): 24–30 excellent, 18–23 strong, 12–17 developing, 0–11 weak.
- D2 User Needs (out of 20):          16–20 excellent, 12–15 strong, 8–11 developing, 0–7 weak.
- D3 Conversion (out of 30):          24–30 excellent, 18–23 strong, 12–17 developing, 0–11 weak.
- D4 Design Execution (out of 20):    16–20 excellent, 12–15 strong, 8–11 developing, 0–7 weak.

Be conservative. Most real pages score "Developing" — that is the calibrated norm. Inflating to Strong reads as flattery and breaks trust.

GravitasService enum values:
- experience-strategy-design
- product-design-engineering
- service-design-operations
- ai-data-automation
- capability-enablement

Lens enum values:
- usability | user-needs | conversion | design-execution

Voice in every string: clear, confident, declarative. No "cutting-edge", "leverage", "best-in-class", "synergy". No emojis. Each "why" or "rationale" or "body" is a tight Gravitas sentence — never two.

POSITIVE GRAVITAS STANCE inside every string:
- Speak with conviction about what Gravitas would do. No "we might", "we could try", "perhaps".
- Never undermine Gravitas's positioning. Never apologise for it.
- If a fact is unclear, frame it as "a conversation with the team would scope this" — not as a Gravitas limitation.
- No vulgarity, slurs, or sexual content — ever, regardless of what came before.

Must/Should/Could prioritisation:
- Must = non-negotiables. The audit's high/critical findings.
- Should = desirable improvements. The medium findings + obvious wins.
- Could = directional ideas. Low findings + 1–2 ambitious bets.

Tie each roadmap item to the Gravitas service that owns it (per the audit findings' gravitasService tag).`;

async function composeClaudeStrategy(
  router: ReturnType<typeof getServerRouter>,
  ctx: StrategyNodeCtx,
  input: StrategyNodeInput,
  kbChunks: Awaited<ReturnType<typeof kbSearch>>,
  jsonSystemPrompt: string,
): Promise<ClaudeStrategyJson | null> {
  const auditSummary = summariseAudit(input.audit);
  const kbBlock =
    kbChunks.length > 0
      ? `\n\nGravitas KB excerpts (use these for grounding but do not fabricate):\n${kbChunks
          .map(
            (c, i) =>
              `[${i + 1}] ${c.title || "(untitled)"} — ${c.url}\n${truncate(c.text, 400)}`,
          )
          .join("\n\n")}`
      : "";

  const user = [
    input.visitor.namedProblem
      ? `Visitor's named problem: "${input.visitor.namedProblem}"`
      : "Visitor did not name a problem.",
    input.visitor.industry ? `Industry: ${input.visitor.industry}` : null,
    input.visitor.role ? `Role: ${input.visitor.role}` : null,
    "",
    "Audit summary:",
    auditSummary,
    kbBlock,
    "",
    "Output the JSON now.",
  ]
    .filter(Boolean)
    .join("\n");

  // Try once; if parse fails, try one more time with stricter wording.
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys =
      attempt === 0
        ? jsonSystemPrompt
        : jsonSystemPrompt +
          `\n\nRETRY — previous response failed JSON validation. Output ONLY the JSON object with no surrounding text.`;
    const result = await router.complete({
      purpose: "voice-heavy",
      node: "strategy",
      sessionId: ctx.sessionId,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      maxTokens: 2048,
      temperature: 0.3,
      signal: ctx.signal,
    });
    const parsed = parseStrategyJson(result.text);
    if (parsed) return parsed;
    // eslint-disable-next-line no-console
    console.warn(`[strategy] JSON parse failed on attempt ${attempt + 1}`);
  }
  return null;
}

function parseStrategyJson(text: string): ClaudeStrategyJson | null {
  // Pull the first balanced top-level {...} block. We tolerate models that
  // sneak code fences or short prefaces.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = ClaudeStrategyJson.safeParse(obj);
  if (!parsed.success) return null;
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Hydration: ClaudeStrategyJson → StrategyResult (adds normalizedScore +
// maxScore + totalScore, since those are mechanical from the rubric)
// ---------------------------------------------------------------------------

function hydrateFromClaude(json: ClaudeStrategyJson): StrategyResult {
  const axes = json.maturity.axes.map((axis) => {
    const max = axis.label === "User Needs" || axis.label === "Design Execution" ? 20 : 30;
    const raw = clamp(axis.rawScore, 0, max);
    const normalized = (raw / max) * 10;
    return {
      label: axis.label,
      rawScore: raw,
      normalizedScore: Math.round(normalized * 100) / 100,
      maxScore: max as 20 | 30,
      rationale: axis.rationale,
    };
  }) as [
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
  ];
  const totalScore = axes.reduce((s, a) => s + a.rawScore, 0);

  return {
    maturity: {
      axes,
      totalScore,
      targetScore: json.maturity.targetScore ?? null,
    },
    roadmap: {
      mode: "priority",
      must: json.roadmap.must,
      should: json.roadmap.should,
      could: json.roadmap.could,
    },
    themes: json.themes,
    keepAndBuildOn: json.keepAndBuildOn ?? [],
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback — derived from audit data when Claude failed
// ---------------------------------------------------------------------------

function deterministicStrategy(audit: AuditResult | null): StrategyResult {
  // Conservative "Developing" defaults — see Gravitas scoring rubric.
  const fallbackAxes = [
    { label: "Usability Standards" as const, rawScore: 14, maxScore: 30 as const },
    { label: "User Needs" as const, rawScore: 9, maxScore: 20 as const },
    { label: "Conversion" as const, rawScore: 14, maxScore: 30 as const },
    { label: "Design Execution" as const, rawScore: 9, maxScore: 20 as const },
  ];

  if (audit && typeof audit.accessibility.score === "number") {
    // Crude tie: shift D4 by how close a11y is to 100.
    fallbackAxes[3]!.rawScore = clamp(Math.round((audit.accessibility.score / 100) * 20), 0, 20);
  }

  const axes = fallbackAxes.map((a) => ({
    label: a.label,
    rawScore: a.rawScore,
    normalizedScore: Math.round((a.rawScore / a.maxScore) * 10 * 100) / 100,
    maxScore: a.maxScore,
    rationale: `Calibrated to "Developing" based on the audit pass; refine with a human reviewer.`,
  })) as [
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
    StrategyResult["maturity"]["axes"][number],
  ];
  const totalScore = axes.reduce((s, a) => s + a.rawScore, 0);

  // Pull roadmap items from the audit findings, by severity bucket.
  const must: StrategyResult["roadmap"]["must"] = [];
  const should: StrategyResult["roadmap"]["should"] = [];
  const could: StrategyResult["roadmap"]["could"] = [];
  if (audit) {
    for (const f of audit.findings) {
      const item = {
        title: f.title,
        why: f.detail.slice(0, 240),
        gravitasService: (f.gravitasService ?? "experience-strategy-design") as GravitasService,
      };
      if (f.severity === "critical" || f.severity === "high") {
        if (must.length < 6) must.push(item);
      } else if (f.severity === "medium") {
        if (should.length < 6) should.push(item);
      } else {
        if (could.length < 6) could.push(item);
      }
    }
  }
  // Pad empty groups with calibrated honest placeholders so the radar/roadmap
  // canvas component still has meaningful structure.
  if (must.length === 0) {
    must.push({
      title: "Confirm what 'good' looks like with the team",
      why: "Without an internal benchmark, every improvement is opinion.",
      gravitasService: "experience-strategy-design",
    });
  }
  if (should.length === 0) {
    should.push({
      title: "Audit the next two pages along the same flow",
      why: "Single-page audits miss patterns; the next steps need the journey view.",
      gravitasService: "experience-strategy-design",
    });
  }
  if (could.length === 0) {
    could.push({
      title: "Sketch a 1-pager target state for the team to react to",
      why: "Faster feedback when there's a concrete artefact, not just findings.",
      gravitasService: "experience-strategy-design",
    });
  }

  return {
    maturity: { axes, totalScore, targetScore: 75 },
    roadmap: { mode: "priority", must, should, could },
    themes: [
      {
        title: "The fundamentals are uneven — uneven is the work",
        body:
          "A single-page audit only sees the slice you submitted. The interesting redesign question is which fundamentals scale across the rest of the journey.",
      },
      {
        title: "Speed and content density are doing different jobs",
        body:
          "Performance is what the visitor feels before reading; content is what convinces them once they do. Both need attention together, not in sequence.",
      },
      {
        title: "Accessibility wins double as AI-readability wins",
        body:
          "Clean semantic HTML helps screen readers AND search-engine AI. The same fix moves both audiences forward — a rare double-coverage moment.",
      },
      {
        title: "Treat 'developing' as a starting position, not a verdict",
        body:
          "Most real pages score here. The redesign goal is to widen the gap to category-leading on the two lenses that move conversion most.",
      },
    ],
    keepAndBuildOn: [],
  };
}

// ---------------------------------------------------------------------------
// Narration — 3 sentences explaining the synthesis
// ---------------------------------------------------------------------------

const NARRATION_SYSTEM = `You are the Gravitas Transformation Co-Pilot. Compose EXACTLY 3 sentences narrating the strategy you just produced.

Voice: clear, declarative, confident. No emojis. No "cutting-edge"/"leverage"/"best-in-class"/"synergy". Never call yourself an AI.

Content rules:
- Reference the maturity total and the single highest-impact Must item by name.
- POSITIVE GRAVITAS STANCE: speak with conviction about what the team would deliver next. No hedging about Gravitas's capability.
- PUSH TO CONTACT — close the third sentence by inviting the visitor to take this further with the Gravitas team (the Output node will name the contact, so here keep it as "the team" or "a conversation with the team").
- Stay strictly on-topic: digital, product, experience, AI, or service-design work. No off-topic asides.
- No vulgarity, slurs, or sexual content — ever.`;

async function streamSynthesisNarration(
  router: ReturnType<typeof getServerRouter>,
  ctx: StrategyNodeCtx,
  strategy: StrategyResult,
  input: StrategyNodeInput,
  kbChunks: Awaited<ReturnType<typeof kbSearch>>,
  narrationSystemPrompt: string,
): Promise<string> {
  const topMust = strategy.roadmap.must[0];
  const factSheet = JSON.stringify(
    {
      totalScore: strategy.maturity.totalScore,
      target: strategy.maturity.targetScore,
      topMust: topMust ? { title: topMust.title, why: topMust.why } : null,
      themeTitles: strategy.themes.map((t) => t.title),
      visitorProblem: input.visitor.namedProblem,
      kbCited: kbChunks[0]
        ? { title: kbChunks[0].title, url: kbChunks[0].url }
        : null,
    },
    null,
    2,
  );

  try {
    const { stream, done } = await router.stream({
      purpose: "voice-heavy",
      node: "strategy",
      sessionId: ctx.sessionId,
      messages: [
        { role: "system", content: narrationSystemPrompt },
        {
          role: "user",
          content:
            "Fact sheet for your narration (do not echo as JSON):\n" + factSheet,
        },
      ],
      maxTokens: 320,
      temperature: 0.45,
      signal: ctx.signal,
    });
    let text = "";
    ctx.writer.writeText("\n\n");
    for await (const chunk of stream) {
      text += chunk.textDelta;
      ctx.writer.writeText(chunk.textDelta);
    }
    await done;
    return text;
  } catch (err) {
    if (err instanceof DailyCapExceeded) throw err;
    if (isRouterError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[strategy] narration router error:", err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("[strategy] narration error", err);
    }
    const fallback =
      `Maturity lands at ${strategy.maturity.totalScore}/100 today` +
      (strategy.maturity.targetScore
        ? ` — a typical post-engagement target is ${strategy.maturity.targetScore}.`
        : ".") +
      (topMust ? ` The highest-impact Must is: ${topMust.title.toLowerCase()}.` : "") +
      " Mapping these to Gravitas services next.";
    ctx.writer.writeText("\n\n" + fallback);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summariseAudit(audit: AuditResult | null): string {
  if (!audit) return "No audit was performed for this session.";
  return JSON.stringify(
    {
      url: audit.url,
      performance: audit.performance,
      accessibilityScore: audit.accessibility.score,
      accessibilityIssues: audit.accessibility.issues,
      semantic: {
        title: audit.semantic.title,
        headings: audit.semantic.headingCounts,
        structuredData: audit.semantic.structuredDataTypes,
        lang: audit.semantic.langAttribute,
      },
      designSignals: audit.designSignals,
      aiReadiness: audit.aiReadiness,
      contentArchitecture: audit.contentArchitecture,
      findings: audit.findings.map((f) => ({
        title: f.title,
        severity: f.severity,
        lens: f.lens,
        category: f.category,
        gravitasService: f.gravitasService,
      })),
    },
    null,
    2,
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
