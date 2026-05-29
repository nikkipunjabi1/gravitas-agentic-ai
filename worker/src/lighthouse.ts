import type { FastifyBaseLogger } from "fastify";
import type { AuditResult, Accessibility, Performance, Semantic } from "./types.js";
import { logWorkerCall } from "./call-log.js";

/**
 * Lighthouse via Google PageSpeed Insights (PSI) API.
 *
 * Why PSI and not in-process Lighthouse:
 *   - PSI runs Lighthouse on Google's infrastructure, from Google's IPs.
 *   - Enterprise WAFs (Cloudflare, Akamai, F5, Imperva) don't block Google.
 *   - We get the same Lighthouse JSON we'd get locally, without needing
 *     to bypass bot defences.
 *   - Free: 25,000 requests/day with an API key, lower limits without.
 *
 * Endpoint: https://www.googleapis.com/pagespeedonline/v5/runPagespeed
 *
 * Latency: 15-25s per call (Lighthouse runs server-side). That's the new
 * audit floor. Worth it — protected sites that used to fail now succeed.
 *
 * API key (optional but recommended):
 *   - Without: ~1-5 req/sec, ~100/day shared global pool. Fine for dev.
 *   - With:    400 req/sec, 25k/day per project. Get one from
 *              https://developers.google.com/speed/docs/insights/v5/get-started
 *   - Env var: PAGESPEED_INSIGHTS_API_KEY
 */

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// PSI sometimes takes 40-60s on heavy enterprise sites (ADCB measured at
// 42s, banking/government typical 35-50s). 90s gives headroom for the
// worst case without making genuine failures linger forever.
const PSI_TIMEOUT_MS = 90_000;

export interface PsiOptions {
  url: string;
  strategy?: "desktop" | "mobile";
  signal?: AbortSignal;
  /** Optional session id — surfaces this PSI call in the admin timeline. */
  sessionId?: string | null;
}

// ---------------------------------------------------------------------------
// Minimal PSI response typing — only the fields we read.
// ---------------------------------------------------------------------------

interface PsiAudit {
  id?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: {
    items?: Array<Record<string, unknown>>;
  };
}

interface PsiResponse {
  lighthouseResult?: {
    lighthouseVersion?: string;
    fetchTime?: string;
    requestedUrl?: string;
    finalUrl?: string;
    finalDisplayedUrl?: string;
    runWarnings?: string[];
    runtimeError?: { code?: string; message?: string };
    categories?: {
      performance?: { score?: number | null };
      accessibility?: { score?: number | null };
      "best-practices"?: { score?: number | null };
      seo?: { score?: number | null };
    };
    audits?: Record<string, PsiAudit>;
  };
  error?: { code?: number; message?: string };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runLighthouseViaPsi(
  opts: PsiOptions,
  log: FastifyBaseLogger,
): Promise<AuditResult> {
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? null;
  const apiKey = process.env.PAGESPEED_INSIGHTS_API_KEY;

  const params = new URLSearchParams({
    url: opts.url,
    strategy: opts.strategy ?? "desktop",
    // Request all four categories — they all come back in one call so this
    // doesn't add latency.
    category: "performance",
  });
  // Repeating `category` adds the other lighthouse categories.
  params.append("category", "accessibility");
  params.append("category", "best-practices");
  params.append("category", "seo");
  if (apiKey) {
    params.set("key", apiKey);
  }

  const controller = new AbortController();
  // Track whether OUR timer fired so we can produce a clearer error than
  // the generic "This operation was aborted" — that message is the same
  // regardless of which side aborted, and led ops to think PSI itself was
  // down when really we just gave it too short a budget.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PSI_TIMEOUT_MS);
  const linkedSignal = opts.signal
    ? linkAbort(opts.signal, controller)
    : controller.signal;

  log.info({ url: opts.url, withKey: Boolean(apiKey) }, "psi: starting");

  // Track outcome so the finally block can write one row to model_calls
  // regardless of which code path we exit through. Performance numbers from
  // the parsed Lighthouse result populate the resultSummary when available.
  let httpStatus: number | null = null;
  let resultSummary = "";
  let wasBlocked = false;
  let auditResult: AuditResult | null = null;
  let responseSnapshot: Record<string, unknown> | null = null;

  try {
    let res: Response;
    try {
      res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, {
        method: "GET",
        signal: linkedSignal,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      clearTimeout(timer);
      wasBlocked = true;
      if (timedOut) {
        resultSummary = `timeout ${Math.round(PSI_TIMEOUT_MS / 1000)}s`;
        throw new Error(
          `psi: timed out after ${Math.round(PSI_TIMEOUT_MS / 1000)}s (PSI run did not finish in budget)`,
        );
      }
      resultSummary = `network: ${(err as Error).message}`.slice(0, 120);
      throw new Error(`psi: network ${(err as Error).message}`);
    }
    clearTimeout(timer);
    httpStatus = res.status;

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      wasBlocked = true;
      resultSummary = `HTTP ${res.status}`;
      throw new Error(`psi: HTTP ${res.status} ${detail}`);
    }

    const data = (await res.json()) as PsiResponse;

    if (data.error) {
      wasBlocked = true;
      resultSummary = `error: ${data.error.message ?? "unknown"}`.slice(0, 120);
      throw new Error(`psi: ${data.error.message ?? "unknown error"}`);
    }
    const lr = data.lighthouseResult;
    if (!lr) {
      wasBlocked = true;
      resultSummary = "missing lighthouseResult";
      throw new Error("psi: response missing lighthouseResult");
    }
    if (lr.runtimeError) {
      wasBlocked = true;
      resultSummary = `runtime ${lr.runtimeError.code ?? "?"}`.slice(0, 120);
      throw new Error(
        `psi: lighthouse runtime ${lr.runtimeError.code ?? "?"}: ${lr.runtimeError.message ?? "?"}`,
      );
    }

    auditResult = mapPsiToAuditResult(opts.url, data, startedAt);
    // Compact one-line summary visible in /admin: perf / a11y scores.
    const perf = lr.categories?.performance?.score;
    const a11y = lr.categories?.accessibility?.score;
    const bp = lr.categories?.["best-practices"]?.score;
    const seo = lr.categories?.seo?.score;
    resultSummary = `perf ${perf != null ? Math.round(perf * 100) : "?"} · a11y ${a11y != null ? Math.round(a11y * 100) : "?"}`;
    // Capture a compact Lighthouse snapshot for the admin Flow page.
    // We deliberately don't store the full PSI response (it can be 1–2 MB);
    // the score summary + audit IDs that fired flags is the useful part.
    responseSnapshot = {
      lighthouseVersion: lr.lighthouseVersion ?? null,
      fetchTime: lr.fetchTime ?? null,
      finalUrl: lr.finalUrl ?? null,
      categories: {
        performance: perf,
        accessibility: a11y,
        bestPractices: bp,
        seo,
      },
      runWarnings: lr.runWarnings ?? [],
    };
    return auditResult;
  } finally {
    await logWorkerCall(
      {
        sessionId,
        node: "audit",
        provider: "google-psi",
        model: "lighthouse-v6",
        purpose: "lighthouse",
        latencyMs: Date.now() - startedAt,
        wasBlocked,
        resultSummary: httpStatus
          ? `${httpStatus} · ${resultSummary}`
          : resultSummary || "no-response",
        requestPayload: {
          endpoint: PSI_ENDPOINT,
          method: "GET",
          url: opts.url,
          strategy: opts.strategy ?? "desktop",
          hasApiKey: Boolean(apiKey),
        },
        responsePayload:
          responseSnapshot ?? { httpStatus, error: resultSummary || "no-response" },
      },
      log,
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping PSI → AuditResult
// ---------------------------------------------------------------------------

function mapPsiToAuditResult(
  url: string,
  data: PsiResponse,
  startedAt: number,
): AuditResult {
  const lr = data.lighthouseResult ?? {};
  const audits = lr.audits ?? {};
  const cats = lr.categories ?? {};

  const performance: Performance = {
    lcpMs: numericMs(audits["largest-contentful-paint"]),
    fcpMs: numericMs(audits["first-contentful-paint"]),
    ttfbMs: numericMs(audits["server-response-time"]),
    cls: numericRaw(audits["cumulative-layout-shift"]),
  };

  const a11yRawScore = cats.accessibility?.score;
  const accessibility: Accessibility = {
    score: typeof a11yRawScore === "number" ? Math.round(a11yRawScore * 100) : null,
    issues: extractA11yIssues(audits),
  };

  const semantic: Semantic = {
    title: cleanDisplayValue(audits["document-title"]?.displayValue),
    metaDescription: cleanDisplayValue(audits["meta-description"]?.displayValue),
    headingCounts: {}, // PSI doesn't expose; filled by Playwright if available
    structuredDataTypes: [], // PSI doesn't expose
    langAttribute: audits["html-has-lang"]?.score === 1 ? "en" : null,
  };

  // PSI exposes structured-data validity but not the @type values themselves.
  // We mark hasSitemap/hasRobotsTxt heuristically from related audits.
  const aiReadiness: AuditResult["aiReadiness"] = {
    hasSitemap: false, // not exposed by PSI; Playwright probe sets this
    hasRobotsTxt: audits["robots-txt"]?.score !== 0,
    hasOpenGraph: false, // not exposed by PSI
    score: null,
  };

  return {
    url,
    crawledAt: lr.fetchTime ?? new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    engine: {
      name: "google-psi",
      version: lr.lighthouseVersion ?? "unknown",
    },
    performance,
    accessibility,
    semantic,
    designSignals: {
      buttonVariants: 0, // Playwright-only
      headingSizes: 0,
      rtlObserved: false,
    },
    aiReadiness,
    contentArchitecture: {
      wordCount: 0, // Playwright-only
      navLinkCount: 0,
      primaryCtaAboveFold: null,
    },
    __phase: null,
  };
}

/**
 * Translate failing Lighthouse a11y audits into our issues format.
 * Only includes the audits that map cleanly to user-impact severity buckets.
 */
function extractA11yIssues(
  audits: Record<string, PsiAudit>,
): Accessibility["issues"] {
  const mapping: Array<{ id: string; severity: Accessibility["issues"][number]["severity"] }> = [
    { id: "image-alt", severity: "high" },
    { id: "color-contrast", severity: "high" },
    { id: "label", severity: "high" },
    { id: "link-name", severity: "high" },
    { id: "button-name", severity: "high" },
    { id: "aria-required-attr", severity: "high" },
    { id: "html-has-lang", severity: "medium" },
    { id: "html-lang-valid", severity: "medium" },
    { id: "document-title", severity: "medium" },
    { id: "heading-order", severity: "medium" },
    { id: "duplicate-id-aria", severity: "medium" },
    { id: "aria-allowed-attr", severity: "medium" },
    { id: "aria-required-children", severity: "medium" },
    { id: "aria-required-parent", severity: "medium" },
    { id: "aria-valid-attr", severity: "medium" },
    { id: "aria-valid-attr-value", severity: "medium" },
    { id: "tabindex", severity: "low" },
    { id: "skip-link", severity: "low" },
    { id: "meta-description", severity: "low" },
  ];

  const out: Accessibility["issues"] = [];
  for (const { id, severity } of mapping) {
    const audit = audits[id];
    if (!audit) continue;
    // score === null means "not applicable" — skip those.
    // score === 1 means "passed" — skip.
    // score === 0 or 0 < score < 1 means partial failure → include.
    if (audit.score === 1 || audit.score === null || audit.score === undefined) continue;
    const itemCount = audit.details?.items?.length;
    out.push({
      rule: id,
      severity,
      count: typeof itemCount === "number" && itemCount > 0 ? itemCount : 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function numericMs(audit: PsiAudit | undefined): number | null {
  const v = audit?.numericValue;
  return typeof v === "number" ? Math.round(v) : null;
}

function numericRaw(audit: PsiAudit | undefined): number | null {
  const v = audit?.numericValue;
  return typeof v === "number" ? Math.round(v * 1000) / 1000 : null;
}

function cleanDisplayValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function linkAbort(external: AbortSignal, internal: AbortController): AbortSignal {
  if (external.aborted) internal.abort(external.reason);
  else external.addEventListener("abort", () => internal.abort(external.reason), { once: true });
  return internal.signal;
}
