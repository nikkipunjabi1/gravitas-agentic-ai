import "server-only";
import { getServerRouter } from "@/server/model-router";
import { crawlUrl } from "@/agents/tools/crawl-url";
import { renderUI } from "@/agents/tools/render-ui";
import { deriveFindings, deriveStrengths } from "@/agents/findings";
import { DailyCapExceeded, isRouterError } from "@/lib/models";
import { consumeAudit } from "@/lib/quota";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type { AuditResult, VisitorContext } from "@/agents/state";

/**
 * Audit node — Phase 1.4.
 *
 * Pipeline:
 *   1. Consume one daily audit from per-IP quota. If exhausted, emit
 *      RateLimitReached and bail out (return signals "skip audit").
 *   2. Fetch the AuditResult from the crawl worker.
 *   3. Derive findings + strengths via the heuristic rule set.
 *   4. Emit KeepAndBuildOn UIAction (positive first, per Gravitas method).
 *   5. Emit AuditFindings UIAction (severity-sorted).
 *   6. Stream a voice-heavy narration via Claude — 3–4 sentences.
 *
 * Returns state patches the graph merges. On rate-limit, sets a flag the
 * graph reads to skip downstream nodes; on cap-exceeded throw, the graph's
 * conditional edge routes to CapReached.
 *
 * Phase 2 swap-ins:
 *   - DeepSeek-R1 reasoning replaces heuristic finding derivation.
 *   - Shadow Audit (parallel branch starting mid-Discovery) replaces the
 *     sequential call here.
 *   - Annotated screenshot for the Phase 3 PDF.
 */

export interface AuditNodeCtx {
  writer: DataStreamWriter;
  sessionId: string;
  ipHash: string;
  signal?: AbortSignal;
}

export interface AuditNodeInput {
  visitor: VisitorContext;
}

export interface AuditNodeOutput {
  audit: AuditResult | null;
  /** Set when per-IP audit quota was exhausted; graph short-circuits. */
  rateLimited: boolean;
  /** Set when worker returned an error we cannot recover from. */
  failed: boolean;
  /** Text streamed to chat — appended to history via the graph. */
  assistantText: string;
}

export async function runAudit(
  ctx: AuditNodeCtx,
  input: AuditNodeInput,
): Promise<AuditNodeOutput> {
  const url = input.visitor.submittedUrl;
  if (!url) {
    // Shouldn't get here — the graph guards on this — but be defensive.
    return { audit: null, rateLimited: false, failed: true, assistantText: "" };
  }

  // ---- 1. Per-IP audit quota ---------------------------------------------
  const quota = await consumeAudit(ctx.ipHash);
  if (!quota.accepted) {
    renderUI(
      ctx.writer,
      {
        type: "RateLimitReached",
        id: crypto.randomUUID(),
        version: 1,
        data: {
          reason: "audits",
          headline: "You've used today's deep audit.",
          body:
            "We deliberately cap deep page audits to one per visitor per day so the model spend stays sustainable. " +
            "Come back at 00:00 UTC for another audit — and we can keep talking in the meantime.",
          remainingResetIn: untilUtcMidnight(),
        },
      },
      { sessionId: ctx.sessionId, node: "audit" },
    );
    const text =
      "I've already audited a page for this visitor today — that's the daily cap. " +
      "Tell me about the friction you're seeing and I can still reason through it from what you describe.";
    ctx.writer.writeText("\n\n" + text);
    return { audit: null, rateLimited: true, failed: false, assistantText: text };
  }

  // ---- 2. Crawl ---------------------------------------------------------
  const crawl = await crawlUrl({
    url,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  });
  if (!crawl.ok) {
    // eslint-disable-next-line no-console
    console.warn("[audit] crawl failed:", crawl.reason, crawl.error);
    const text = composeCrawlFailure(url, crawl.reason, crawl.error);
    ctx.writer.writeText("\n\n" + text);
    return { audit: null, rateLimited: false, failed: true, assistantText: text };
  }

  // ---- 3. Derive findings + strengths -----------------------------------
  const findings = deriveFindings(crawl.result);
  const strengths = deriveStrengths(crawl.result);
  const enriched: AuditResult = { ...crawl.result, findings };

  // ---- 4. Emit KeepAndBuildOn (positive first per Gravitas methodology) -
  renderUI(
    ctx.writer,
    {
      type: "KeepAndBuildOn",
      id: crypto.randomUUID(),
      version: 1,
      data: {
        strengths: strengths.map((s) => ({
          title: s.title,
          detail: s.detail,
          lens: s.lens,
        })) as [
          { title: string; detail: string; lens: AuditResult["findings"][number]["lens"] },
          { title: string; detail: string; lens: AuditResult["findings"][number]["lens"] },
          ...Array<{ title: string; detail: string; lens: AuditResult["findings"][number]["lens"] }>,
        ],
        alsoWorking: [],
      },
    },
    { sessionId: ctx.sessionId, node: "audit" },
  );

  // ---- 5. Emit AuditFindings -------------------------------------------
  renderUI(
    ctx.writer,
    {
      type: "AuditFindings",
      id: crypto.randomUUID(),
      version: 1,
      data: {
        findings: findings.map((f) => ({
          id: f.id,
          lens: f.lens,
          category: f.category,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          gravitasService: f.gravitasService,
        })),
      },
    },
    { sessionId: ctx.sessionId, node: "audit" },
  );

  // ---- 6. Narrate -------------------------------------------------------
  const router = getServerRouter();
  let assistantText = "";
  try {
    const system =
      "You are the Gravitas Transformation Co-Pilot reporting an audit. " +
      "Voice: clear, confident, declarative, present-tense. No emojis. " +
      "Compose exactly 3 sentences:\n" +
      "  1. Open with the URL audited and one calibrated overall observation.\n" +
      "  2. Name the single most impactful finding in plain language.\n" +
      "  3. Pivot to the synthesis the next response will cover.\n" +
      "POSITIVE GRAVITAS STANCE: speak with conviction about what Gravitas would do with this. Never apologise for the brand. " +
      "Stay strictly on-topic — digital, product, experience, AI, or service-design observations only. " +
      "No vulgarity, slurs, or sexual content — ever. " +
      "Never call yourself an AI. Never use 'cutting-edge', 'leverage', or 'best-in-class'.";

    const user =
      `Audit summary (JSON, for your reasoning only — do not echo verbatim):\n\n` +
      JSON.stringify(
        {
          url: enriched.url,
          perf: enriched.performance,
          a11y: { score: enriched.accessibility.score },
          structure: {
            words: enriched.contentArchitecture.wordCount,
            headings: enriched.semantic.headingCounts,
          },
          designSignals: enriched.designSignals,
          topFindings: findings
            .slice(0, 3)
            .map((f) => ({ title: f.title, severity: f.severity, lens: f.lens })),
          strengths: strengths.map((s) => s.title),
        },
        null,
        2,
      );

    const { stream, done } = await router.stream({
      purpose: "voice-heavy",
      node: "audit",
      sessionId: ctx.sessionId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 320,
      temperature: 0.45,
      signal: ctx.signal,
    });
    ctx.writer.writeText("\n\n");
    for await (const chunk of stream) {
      assistantText += chunk.textDelta;
      ctx.writer.writeText(chunk.textDelta);
    }
    await done;
  } catch (err) {
    if (err instanceof DailyCapExceeded) throw err;
    if (isRouterError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[audit] narration router error:", err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("[audit] narration error", err);
    }
    // Deterministic fallback narration from the findings themselves so the
    // session continues even if voice composition failed.
    const top = findings[0];
    assistantText =
      `Audited ${enriched.url}. ` +
      (top
        ? `The most impactful issue is: ${top.title.toLowerCase()}. `
        : "Nothing critical surfaced on this single-page pass. ") +
      "Pulling the synthesis together now.";
    ctx.writer.writeText("\n\n" + assistantText);
  }

  return { audit: enriched, rateLimited: false, failed: false, assistantText };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function composeCrawlFailure(url: string, reason: string, errorMessage: string): string {
  const host = safeHost(url);

  // PSI failures bubble up with a "psi:" prefix from worker/src/lighthouse.ts.
  // These represent OUR auditor's primary path failing, NOT the site
  // misbehaving — surface separately so the message tells the operator
  // what THEY can fix (key, quota, API enablement) rather than blaming
  // the target site.
  const isPsiError = /\bpsi:/i.test(errorMessage);
  if (isPsiError && reason === "remote") {
    return composePsiFailure(host, errorMessage);
  }

  // Extract the upstream HTTP status if the error string carries one
  // ("upstream returned HTTP 403"). Lets us distinguish bot-blocks (403/406/451),
  // 404s, and 5xx outages — each gets a different, more honest message.
  const statusMatch = errorMessage.match(/HTTP\s+(\d{3})/i);
  const upstreamStatus = statusMatch ? Number(statusMatch[1]) : null;

  switch (reason) {
    case "config":
      return (
        "The crawl worker isn't configured in this environment, so I can't fetch the page right now. " +
        "Tell me what you're seeing and I'll reason through it without the audit data."
      );

    case "auth":
      return (
        "The crawl worker rejected the request — that's a configuration issue on our side, not yours. " +
        "I'll keep going from your description in the meantime."
      );

    case "network":
      return (
        `I couldn't reach ${host} from the auditor — the request never connected. ` +
        "That's usually a DNS, TLS, or firewall issue at the network level. " +
        "Tell me what you'd like reviewed and I'll reason from there."
      );

    case "remote": {
      // 403 / 406 / 451 — bot defences. Enterprise sites, especially banking
      // and government, run Cloudflare / Akamai / F5 in front. The auditor
      // CAN'T (and shouldn't) bypass an aggressive WAF — admit it and pivot.
      if (upstreamStatus === 403 || upstreamStatus === 406 || upstreamStatus === 451) {
        return (
          `${host} blocked the audit — it sits behind enterprise bot protection (Cloudflare / Akamai / F5 are the usual suspects). ` +
          "That's a fair posture for them to take, but it means I can't pull the page automatically. " +
          "What I CAN do: reason about the site from what you describe. Tell me what you've noticed — load time, friction points, the journey you're worried about — and I'll work from there."
        );
      }
      if (upstreamStatus === 404 || upstreamStatus === 410) {
        return (
          `That URL returned a ${upstreamStatus} — the page isn't there. ` +
          "Double-check the link, or paste a different page you want audited."
        );
      }
      if (upstreamStatus && upstreamStatus >= 500) {
        return (
          `${host} returned an HTTP ${upstreamStatus} — the site itself is down or erroring. ` +
          "Try again in a few minutes, or describe what you wanted reviewed and I'll reason from there."
        );
      }
      if (upstreamStatus === 429) {
        return (
          `${host} rate-limited the audit (HTTP 429). They've seen too many requests recently — try again in a few minutes.`
        );
      }
      // Worker returned 500 with an unstructured error.
      return (
        `The crawl of ${host} didn't complete cleanly. ` +
        (upstreamStatus
          ? `The site returned HTTP ${upstreamStatus}. `
          : "The site returned something we couldn't make sense of. ") +
        "Want to describe what you'd like reviewed and I'll work from your words?"
      );
    }

    case "parse":
    default:
      return (
        `The crawl ran but the response didn't match our expected shape. ` +
        "I'll continue from your description rather than guess."
      );
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * PSI-specific failure messages. Distinct from upstream-site failures so the
 * operator hears "fix your API key" instead of "the site is rate-limiting us".
 *
 * Common PSI failure modes:
 *   - HTTP 429 + "Quota exceeded" → key missing/unloaded OR project quota hit
 *   - HTTP 403 + "API_KEY_*" → key invalid, restricted, or API not enabled
 *   - HTTP 400 + "Invalid value" → URL is malformed or PSI rejected it
 *   - Generic — surface the raw underlying error so the dev console is useful
 */
function composePsiFailure(host: string, errorMessage: string): string {
  const isQuota =
    /\b429\b/.test(errorMessage) || /quota exceeded/i.test(errorMessage);
  const isAuthRejection =
    /\b403\b/.test(errorMessage) ||
    /api[_ ]?key[_ ]?invalid/i.test(errorMessage) ||
    /api not (enabled|activated)/i.test(errorMessage);

  if (isQuota) {
    return (
      `The Lighthouse / PSI path is rate-limited (HTTP 429) AND the live crawl of ${host} couldn't get through — so I can't ship audit data this turn. ` +
      "Most common cause: PSI API key isn't loaded in the worker yet. Two-step fix: " +
      "1) confirm PAGESPEED_INSIGHTS_API_KEY is set in .env.local; " +
      "2) restart `pnpm dev:worker` (the worker reads env at boot, not per-request). " +
      "If both are done already, check that PageSpeed Insights API is ENABLED on the project at https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com — enabling the API is a separate action from creating the key. " +
      "Meanwhile, tell me about the site and I'll reason from your words."
    );
  }

  if (isAuthRejection) {
    return (
      "PageSpeed Insights rejected our API key (HTTP 403). " +
      "Likely causes: the key has IP/HTTP-referrer restrictions that don't match this server, OR the PSI API isn't enabled on the project yet (enabling is a separate step from creating the key). " +
      "Visit https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com and click Enable, then restart `pnpm dev:worker`."
    );
  }

  // Generic PSI failure — surface a redacted version of the underlying message.
  const trimmed = errorMessage.replace(/^.*?psi:\s*/i, "").slice(0, 240);
  return (
    `The Lighthouse / PSI primary path failed, and the live crawl of ${host} couldn't get through either. ` +
    `Underlying: ${trimmed}. ` +
    "Describe what you'd like reviewed and I'll work from there."
  );
}

function untilUtcMidnight(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
  if (minutes <= 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
