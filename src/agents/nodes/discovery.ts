import "server-only";
import { getServerRouter } from "@/server/model-router";
import { kbSearch } from "@/agents/tools/kb-search";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type { VisitorContext } from "@/agents/state";

/**
 * Discovery node — Phase 1.
 *
 * Two responsibilities:
 *
 *   1. CLASSIFY the visitor's latest message into one of four intents:
 *        problem-statement | gravitas-question | meta-question | off-topic
 *      Classification runs on Ollama Qwen3 via `purpose: "intent"`. The
 *      response is a tight JSON shape we zod-parse here.
 *
 *   2. RESPOND in the Gravitas voice using Claude voice-light, streamed back
 *      via the writer. For `gravitas-question` we ground the response on
 *      top-k Gravitas KB chunks. For other intents we use short templated
 *      systems + the conversation as context.
 *
 * Side effects:
 *   - Streams text deltas to `ctx.writer` (chat pane sees them live).
 *   - Returns a partial state update — caller merges into SessionState.
 *
 * Visitor-context extraction (industry / role / namedProblem / submittedUrl)
 * happens via two cheap classifications on the user's last message. Phase 2
 * may swap this for a structured-output JSON pass.
 *
 * See docs/AGENTS.md → Discovery.
 */

import type { Message as RouterMessage } from "@/lib/models";

export type DiscoveryIntent =
  | "problem-statement"
  | "gravitas-question"
  | "meta-question"
  | "off-topic";

export interface DiscoveryContext {
  writer: DataStreamWriter;
  sessionId: string;
  signal?: AbortSignal;
}

export interface DiscoveryInput {
  /** Latest visitor message. */
  userMessage: string;
  /** Prior turns — system message is added by the node itself. */
  history: RouterMessage[];
  /** Current visitor knowledge — sparse fields, may be null. */
  visitor: VisitorContext;
}

export interface DiscoveryOutput {
  intent: DiscoveryIntent;
  assistantText: string;
  /** Any newly-extracted visitor context — caller merges into state.visitor. */
  visitorPatch: Partial<VisitorContext>;
  /** True if Discovery believes it has enough context to transition. */
  ready: boolean;
}

const VOICE_SYSTEM_BASE = `You are the Gravitas Transformation Co-Pilot — a consulting product representing Gravitas (https://thisisgravitas.com). You are NOT a general-purpose assistant.

GRAVITAS IS — five service areas. These are the ONLY services to name. Never invent additional ones:

1. Experience Strategy & Design — customer research, journey design, service blueprints, brand-into-product translation.
2. Product Design & Engineering — building digital products end-to-end, design systems, modern web/mobile stack, platform migrations.
3. Service Design & Operations — process redesign, operating-model work, team workflows + handoffs.
4. AI, Data & Automation — AI strategy, ML/LLM-powered apps, data architecture, RAG, intelligent automation.
5. Capability & Enablement — team training, design ops, dev ops upskilling, in-house capability uplift.

HARD TOPIC GUARDRAIL — you ONLY discuss:
  (a) the visitor's digital / business / experience / product / AI problem
  (b) how Gravitas thinks about it and which of the five services would own it
  (c) auditing the visitor's website (if they paste a URL)
  (d) how to get in touch with the Gravitas team

If the visitor asks ANYTHING outside that scope — celebrity gossip, sports scores, math homework, coding help unrelated to their product, current events, weather, recipes, jokes, role-play, debates, anything off-topic — you politely refuse in ONE sentence and pivot in ONE more sentence: "That's outside what I'm here for — I help with digital, product, AI and experience challenges that Gravitas can solve. What are you working on?"

NEVER answer the off-topic question even partially. Don't say "I can't, BUT here's a hint about it" — just refuse + pivot, in two sentences total.

POSITIVE GRAVITAS STANCE — you are always positive and confident about Gravitas:
  - Gravitas's work is strong; speak with conviction about what the team delivers.
  - If asked about competitors or comparisons, redirect to what Gravitas does best.
  - Never undermine Gravitas's positioning. Never apologise for it.
  - Never say Gravitas "can't" or "doesn't" do something unless you're certain — when uncertain, say "I'd connect you with the team to discuss the specifics."

PUSH TO CONTACT — every meaningful conversation closes with an invitation to reach out:
  - When the visitor names a real friction, a URL, or a goal: in the same reply or the next, invite them to reach the Gravitas team to take it further.
  - Use the named contact when relevant: ${process.env.BRANDING_CLOSING_CONTACT_NAME ? `${process.env.BRANDING_CLOSING_CONTACT_NAME}, ${process.env.BRANDING_CLOSING_CONTACT_ROLE ?? "Gravitas"} (${process.env.BRANDING_CLOSING_CONTACT_EMAIL ?? ""})` : "the Gravitas team at hello@thisisgravitas.com"}.
  - Don't bolt this on awkwardly — weave it in. "Worth a conversation with the team" is the rhythm.

The visitor is here about THEIR work. Don't talk about yourself as a tool ("I help you clarify...", "I turn..."). Talk about THEIR situation and the Gravitas response to it.

Voice rules (priority order):
  1. CLARITY — turn confusion into clarity.
  2. PURPOSE — anchor every reply to clear intent.
  3. SIMPLICITY — tame complexity.
  4. PROGRESS — ship words that work beautifully.

Concrete rules:
  - 2–4 sentences. Never longer.
  - Confident, declarative, present tense. No hedging.
  - No agency-speak: never "cutting-edge", "leverage", "best-in-class", "synergy", "scale", "elevate".
  - No emoji.
  - One question at most, only if it advances the work.
  - Never invent a Gravitas case study, service, employee name, or metric. If uncertain, say "I'd connect you with the team for that."
  - No vulgarity, no sexually explicit content, no slurs — ever, regardless of what the visitor sends.`;

const PROBLEM_SYSTEM = `${VOICE_SYSTEM_BASE}

This visitor is naming a friction or pasting a URL. Your job is to:
- Acknowledge what they said in one tight sentence.
- Ask ONE gap-filling question if a key field is missing (in order: namedProblem → industry → role → submittedUrl). Skip fields we already have.
- Never ask two questions in one reply.
- If all four fields are filled, say so and hand off to the next phase implicitly ("Got it — pulling the audit now.").`;

const KB_GROUNDED_SYSTEM = `${VOICE_SYSTEM_BASE}

The visitor asked about Gravitas. Below are excerpts pulled from the Gravitas website — use ONLY this material to answer. Speak naturally; never reveal the retrieval mechanism.

Rules:
- 2–4 sentences. Paraphrase from the excerpts; you may quote a short phrase.
- Cite at most ONE source inline as: ([page-name](url)).
- If the excerpts don't actually answer the question, do NOT invent. Say plainly that you don't have that detail handy and offer the named contact: "I don't have that detail to hand — Kieran O'Sullivan at kieran.osullivan@thisisgravitas.com (or thisisgravitas.com) can fill you in."
- NEVER use technical terms in your reply: no "chunks", "knowledge base", "vector", "embedding", "RAG", "grounding", "indexed", "retrieved", "context". Speak as a senior consultant would.
- NEVER invent a case study, service name, employee name, or metric.`;

const KB_EMPTY_SYSTEM = `${VOICE_SYSTEM_BASE}

The visitor asked something about Gravitas we don't have a confident answer for from public material.

Rules:
- EXACTLY two sentences.
- Sentence 1: honestly say you don't have that detail to hand, and offer the named contact for it (Kieran O'Sullivan at kieran.osullivan@thisisgravitas.com, or thisisgravitas.com).
- Sentence 2: pivot warmly to ask about their situation so the conversation keeps moving.
- NEVER use technical terms in your reply: no "chunks", "knowledge base", "vector", "embedding", "RAG", "grounding", "indexed", "retrieved", "context", "data". Speak as a senior consultant would.`;

const META_SYSTEM = `${VOICE_SYSTEM_BASE}

The visitor asked about the Co-Pilot itself. Be brief and honest:
- One sentence acknowledging what they asked.
- One sentence redirecting to their problem: "What I'd like to do for you is..."
Two sentences total. Never more.`;

const OFFTOPIC_SYSTEM = `${VOICE_SYSTEM_BASE}

The visitor's message is off-topic for Gravitas. EXACTLY two sentences:
  1. ONE sentence that politely declines without engaging with the off-topic content (don't repeat or summarise it). "That sits outside what I'm here for —" / "Not something I can help with here —" etc.
  2. ONE sentence that pivots them to a Gravitas-relevant prompt — invite them to share a digital problem, a website to audit, or to reach the team directly.

NEVER answer the off-topic question, even partially. Refusal + pivot only.`;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runDiscovery(
  ctx: DiscoveryContext,
  input: DiscoveryInput,
): Promise<DiscoveryOutput> {
  const router = getServerRouter();

  // ---- 1. Classify intent (heuristic — Phase 1 latency optimisation) ----
  // Previously called an LLM (Ollama Qwen3 with Haiku fallback) here, but
  // that cost 1.5–2s per turn on every chat — the Ollama reachability check
  // alone times out at 1.5s when Ollama isn't running locally. The heuristic
  // in heuristicIntent() now covers the four documented intent categories
  // accurately (URL → problem-statement, "gravitas" → gravitas-question,
  // "what services / can you" → gravitas-question, meta-pattern → meta,
  // short greeting → off-topic, default → problem-statement). The LLM call
  // can come back in Phase 2 as a parallel-with-heuristic ambiguity tiebreak.
  const intent = heuristicIntent(input.userMessage);

  // ---- 2. Extract visitor patch (cheap heuristics + Ollama) -----------
  // For Phase 1 the patch is heuristic only — URL via regex, namedProblem if
  // the message contains a friction-shaped phrase, industry/role left null
  // (Phase 2 adds structured-output extraction).
  const visitorPatch = extractVisitorPatchHeuristic(input.userMessage, input.visitor);

  // ---- 3. Respond ------------------------------------------------------
  let assistantText: string;
  switch (intent) {
    case "gravitas-question":
      assistantText = await respondGravitasQuestion(router, ctx, input);
      break;
    case "meta-question":
      assistantText = await respondTemplated(router, ctx, input, META_SYSTEM);
      break;
    case "off-topic":
      assistantText = await respondTemplated(router, ctx, input, OFFTOPIC_SYSTEM);
      break;
    case "problem-statement":
    default:
      assistantText = await respondProblemStatement(router, ctx, input, visitorPatch);
      break;
  }

  // ---- 4. Decide if Discovery is ready to transition -------------------
  const projected: VisitorContext = { ...input.visitor, ...visitorPatch };
  // Ready when a URL is present OR we have a namedProblem AND (industry OR role).
  const ready =
    Boolean(projected.submittedUrl) ||
    (Boolean(projected.namedProblem) && (Boolean(projected.industry) || Boolean(projected.role)));

  return { intent, assistantText, visitorPatch, ready };
}

// ---------------------------------------------------------------------------
// Intent classifier — heuristic only (Phase 1 latency optimisation)
//
// The LLM-based classifier added ~1.5–2s per turn on machines without Ollama
// running (the reachability check alone times out at 1.5s, then Haiku fires).
// For Phase 1 the heuristic below is accurate enough — the four intent
// branches are well-separated by surface signals (URL → problem; literal
// "gravitas" → gravitas-question; meta-pattern → meta; greeting → off-topic).
// Phase 2 may add an LLM tiebreak that runs in parallel with the heuristic
// (resolves with whichever returns first that has high confidence).
// ---------------------------------------------------------------------------

/**
 * Heuristic intent classifier. Pure, fast, deterministic.
 */
export function heuristicIntent(userMessage: string): DiscoveryIntent {
  const m = userMessage.toLowerCase();
  // Gravitas's own URLs are always KB-grounded discussion, never audit targets.
  // The KB has case studies + services pages indexed; the discovery KB lookup
  // will surface the relevant excerpts.
  if (/\bhttps?:\/\/(?:www\.)?thisisgravitas\.com\b/.test(m)) {
    return "gravitas-question";
  }
  if (/\bhttps?:\/\//.test(m)) return "problem-statement";
  // Bare hostname (e.g. "adcb.com", "www.example.co.uk/foo") also reads as a
  // problem-statement so the URL extractor downstream gets a shot at it.
  if (/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|dev|me|info|biz|edu|gov|tech|store|shop|cloud|uk|us|in|de|fr|jp|cn|ru|ca|au|nz|sa|ae|eu)\b/.test(m)) {
    // Bare-hostname thisisgravitas references also stay as gravitas-question.
    if (/\bthisisgravitas\.com\b/.test(m)) return "gravitas-question";
    return "problem-statement";
  }
  if (/\bgravitas\b/.test(m)) return "gravitas-question";
  // "what services do you provide", "what can you help with" — the bot
  // represents Gravitas, so treat services-questions as gravitas-questions.
  if (/\bwhat (services|do you offer|can you help|do you provide)\b/.test(m)) {
    return "gravitas-question";
  }
  if (
    /\b(are you|how does this|what are you|is this an? ai|chatbot|what (can|do) you do)\b/.test(
      m,
    )
  ) {
    return "meta-question";
  }
  if (m.length < 20 && /\b(hi|hello|hey|sup|yo|test|hola)\b/.test(m)) {
    return "off-topic";
  }
  return "problem-statement";
}

// ---------------------------------------------------------------------------
// Voice composition — streams to writer, returns the full text
// ---------------------------------------------------------------------------

async function respondGravitasQuestion(
  router: ReturnType<typeof getServerRouter>,
  ctx: DiscoveryContext,
  input: DiscoveryInput,
): Promise<string> {
  const hits = await kbSearch({
    query: input.userMessage,
    k: 4,
    sessionId: ctx.sessionId,
    node: "discovery",
  });

  const system =
    hits.length > 0
      ? `${KB_GROUNDED_SYSTEM}\n\nKB CHUNKS:\n${formatHits(hits)}`
      : KB_EMPTY_SYSTEM;

  return streamComposition(router, ctx, input, system);
}

async function respondProblemStatement(
  router: ReturnType<typeof getServerRouter>,
  ctx: DiscoveryContext,
  input: DiscoveryInput,
  visitorPatch: Partial<VisitorContext>,
): Promise<string> {
  const projected = { ...input.visitor, ...visitorPatch };
  const known: string[] = [];
  if (projected.namedProblem) known.push(`namedProblem="${projected.namedProblem}"`);
  if (projected.industry) known.push(`industry="${projected.industry}"`);
  if (projected.role) known.push(`role="${projected.role}"`);
  if (projected.submittedUrl) known.push(`submittedUrl="${projected.submittedUrl}"`);

  const system =
    `${PROBLEM_SYSTEM}\n\nKnown so far: ${known.length > 0 ? known.join(", ") : "(nothing yet)"}.`;

  return streamComposition(router, ctx, input, system);
}

async function respondTemplated(
  router: ReturnType<typeof getServerRouter>,
  ctx: DiscoveryContext,
  input: DiscoveryInput,
  system: string,
): Promise<string> {
  return streamComposition(router, ctx, input, system);
}

async function streamComposition(
  router: ReturnType<typeof getServerRouter>,
  ctx: DiscoveryContext,
  input: DiscoveryInput,
  system: string,
): Promise<string> {
  const messages: RouterMessage[] = [
    { role: "system", content: system },
    // Limit history to last 8 turns to keep input cost predictable.
    ...input.history.slice(-8),
    { role: "user", content: input.userMessage },
  ];
  try {
    const { stream, done } = await router.stream({
      purpose: "voice-light",
      node: "discovery",
      sessionId: ctx.sessionId,
      messages,
      maxTokens: 320,
      temperature: 0.4,
      signal: ctx.signal,
    });
    let buf = "";
    for await (const chunk of stream) {
      buf += chunk.textDelta;
      ctx.writer.writeText(chunk.textDelta);
    }
    await done;
    return buf;
  } catch (err) {
    // Router unavailable or refused — emit a static fallback so the visitor
    // still sees something instead of a silent stream.
    // eslint-disable-next-line no-console
    console.warn("[discovery] composition failed:", (err as Error).message);
    const fallback =
      "Tell me one thing — what's the friction you're feeling today, in your own words?";
    ctx.writer.writeText(fallback);
    return fallback;
  }
}

function formatHits(hits: { url: string; title: string; section: string; text: string }[]): string {
  return hits
    .slice(0, 4)
    .map((h, i) => {
      const head = [h.title, h.section].filter(Boolean).join(" · ");
      return `[${i + 1}] ${head} (${h.url})\n${truncate(h.text, 800)}`;
    })
    .join("\n\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Visitor patch — Phase 1 heuristic extraction
// ---------------------------------------------------------------------------

// Primary, high-precision: explicit http(s):// URLs.
const URL_RX = /\bhttps?:\/\/[^\s<>"')]+/i;

// Fallback: bare hostnames like `adcb.com`, `www.example.co.uk/page`. We
// normalise these to `https://` so the audit pipeline gets a valid URL.
// TLD is constrained to 2–12 alpha chars so we don't false-match file
// extensions (filename.txt) or sentence fragments. A denylist below
// catches the common file extensions that still satisfy the regex.
const BARE_DOMAIN_RX =
  /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,12}))(\/[^\s<>"')]*)?/i;

const FILE_EXT_DENYLIST = new Set([
  "txt", "md", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "json", "html", "htm", "css", "js", "ts", "tsx", "jsx", "yml", "yaml",
  "log", "xml", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip",
  "tar", "gz", "rar", "exe", "dmg", "iso", "mp3", "mp4", "mov", "avi",
]);

/**
 * Try to extract a URL from a free-form message. Returns a fully normalised
 * absolute URL (always with a scheme) or null. Two-stage:
 *   1. Look for an explicit http(s):// URL — most reliable, accepted as-is.
 *   2. Otherwise look for a bare hostname token and prefix `https://`.
 *      Reject candidates whose TLD is actually a file extension.
 */
function tryExtractUrl(userMessage: string): string | null {
  const explicit = userMessage.match(URL_RX);
  if (explicit) {
    try {
      const parsed = new URL(explicit[0]);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      // fall through
    }
  }

  const bare = userMessage.match(BARE_DOMAIN_RX);
  if (bare) {
    const tld = (bare[2] ?? "").toLowerCase();
    if (FILE_EXT_DENYLIST.has(tld)) return null;
    const candidate = `https://${bare[0]}`;
    try {
      const parsed = new URL(candidate);
      return parsed.toString();
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Hostname check — is this a Gravitas-owned URL? Returns true for
 * thisisgravitas.com (with or without www). Used to keep the audit
 * pipeline focused on EXTERNAL sites; Gravitas's own pages flow through
 * KB-grounded discussion.
 */
export function isGravitasUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "thisisgravitas.com" || host === "www.thisisgravitas.com";
  } catch {
    return false;
  }
}

/**
 * Did the visitor *actually* ask for an audit, or did they just happen to
 * include a URL? Two signals count as audit intent:
 *
 *   1. Audit-flavoured keywords ("audit", "review", "check", "analyse",
 *      "score", "rate", "lighthouse", "performance", "accessibility",
 *      "what's wrong with"). These read as a direct ask.
 *
 *   2. A "bare URL" — the visitor pasted the link with little surrounding
 *      text. Anything under ~6 chars of text outside the URL is treated as
 *      a bare paste and assumed to mean "audit this." This catches both
 *      `https://example.com` alone and `audit example.com` (the keyword
 *      branch covers the second).
 *
 * Everything else ("can you tell me more about this?",
 * "what is this page about?", "I'm building something similar to <url>")
 * is a discussion request — we DON'T auto-audit, we let Discovery
 * respond and the visitor can ask for an audit on the next turn.
 */
export function hasAuditIntent(message: string, detectedUrl: string): boolean {
  const m = message.toLowerCase();

  // Keyword branch — explicit ask.
  if (/\b(audit|review|check this|analyse|analyze|score|rate this|lighthouse|performance|accessibility|broken|what'?s wrong)\b/.test(m)) {
    return true;
  }

  // Bare-URL branch — paste with no surrounding intent.
  const url = detectedUrl.toLowerCase();
  const host = (() => {
    try {
      return new URL(detectedUrl).host.toLowerCase();
    } catch {
      return "";
    }
  })();
  // Strip the full url AND the bare host from the message; whatever's left
  // is the visitor's actual sentence.
  const stripped = m
    .replace(url, " ")
    .replace(host, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (stripped.length <= 6) return true;

  return false;
}

export function extractVisitorPatchHeuristic(
  userMessage: string,
  current: VisitorContext,
): Partial<VisitorContext> {
  const patch: Partial<VisitorContext> = {};

  // URL gating — two reasons we hold off on populating submittedUrl:
  //
  //   1. Gravitas's own URLs (thisisgravitas.com case studies, services,
  //      contact pages). These are discussion topics for the KB-grounded
  //      Discovery path, NOT pages we audit.
  //
  //   2. Non-Gravitas URLs where the visitor's intent isn't clearly an
  //      audit. Pasting a URL with "tell me more about this" or "what is
  //      this" is a discussion, not a request for a 60-second crawl. We
  //      let Discovery respond conversationally and the visitor can ask
  //      for an audit explicitly on a follow-up turn.
  //
  // When in doubt: Discovery responds, no audit. Better to ask the visitor
  // than to burn a Lighthouse call they didn't want.
  const detected = tryExtractUrl(userMessage);
  if (detected && detected !== current.submittedUrl) {
    const isGravitasOwnUrl = isGravitasUrl(detected);
    const wantsAudit = !isGravitasOwnUrl && hasAuditIntent(userMessage, detected);
    if (wantsAudit) {
      patch.submittedUrl = detected;
    }
  }

  // namedProblem — if we don't have one yet and the message is substantive,
  // store the user's exact phrasing (capped). The agent quotes this back via
  // Strategy + SolutionMap, so verbatim is important.
  if (!current.namedProblem) {
    const trimmed = userMessage.trim();
    if (trimmed.length >= 20 && trimmed.length <= 280) {
      patch.namedProblem = trimmed;
    }
  }

  // industry / role — Phase 1 leaves these to Phase 2's structured extraction.

  return patch;
}
