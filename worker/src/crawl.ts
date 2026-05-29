import { chromium, type Page, type Response as PlaywrightResponse } from "playwright";
import * as cheerio from "cheerio";
import type { FastifyBaseLogger } from "fastify";
import type { Accessibility, AuditResult, ContentArchitecture, DesignSignals, Performance as PerformanceMetrics, Semantic, AIReadiness } from "./types.js";
import { isPrivateAddress } from "./url-guard.js";
import { runLighthouseViaPsi } from "./lighthouse.js";
import { logWorkerCall } from "./call-log.js";

/**
 * runCrawl — real Phase 1 implementation.
 *
 * Pipeline:
 *   1. Launch headless Chromium (Playwright, bundled binary).
 *   2. Navigate to URL with a 30s hard timeout, networkidle wait.
 *   3. TOCTOU re-check: confirm `response.serverAddr()` is NOT a private IP.
 *      Catches DNS rebinding between url-guard's validation and now.
 *   4. Capture Web Vitals (LCP, FCP, TTFB, CLS) via PerformanceObserver
 *      inside page.evaluate.
 *   5. Snapshot HTML, parse with Cheerio for semantic / AI-readiness /
 *      content architecture.
 *   6. Capture design signals (computed-style fingerprints) via page.evaluate.
 *   7. Heuristic accessibility — Cheerio checks for alt text, link labels,
 *      form labels, lang, heading hierarchy. Score derives from issue count.
 *
 * Notes the agent should know about:
 *   - This is heuristic. Lighthouse integration is a follow-up. The agent
 *     should describe findings as "the page" / "the markup", not "Lighthouse
 *     says".
 *   - Every field is non-null on a successful crawl (except where the spec
 *     explicitly allows null — e.g. primaryCtaAboveFold which can't be
 *     reliably inferred from HTML).
 *
 * Phase 2 hardening (tracked in ROADMAP backlog):
 *   - DNS-pinning proxy to close the remaining TOCTOU gap (currently we let
 *     Playwright connect, then validate after — a single TCP/TLS/GET reaches
 *     the host before we abort).
 *   - Mobile viewport pass — current crawl is desktop only.
 *   - Lighthouse a11y + perf scores.
 *   - Annotated screenshot for the Phase 3 PDF report.
 */
// Realistic Chrome 131 UA — what professional auditors (Lighthouse,
// Screaming Frog, WebPageTest) send by default. The previous polite
// "GravitasCoPilotAudit" UA tripped every WAF on first sight.
const REAL_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Top-level crawl orchestrator.
 *
 * Two data sources, run in PARALLEL:
 *
 *   1. Google PSI (primary)  — full Lighthouse audit via Google's infra.
 *      Works on protected sites because nobody blocks Google. Provides
 *      perf, a11y, basic semantic. ~15-25s.
 *
 *   2. Playwright (supplement) — DOM-level structural signals: heading
 *      tree, JSON-LD types, word count, computed-style design fingerprints.
 *      Often blocked by enterprise WAFs; when it fails we still ship PSI
 *      data. ~5-10s when it works.
 *
 * Merge precedence:
 *   - performance / accessibility / title / metaDescription: PSI canonical
 *     (Lighthouse-grade), Playwright as fallback.
 *   - heading counts, structured data types, design signals, word count,
 *     nav links: Playwright only.
 *   - aiReadiness: union of both (Playwright probes robots/sitemap/OG;
 *     PSI's robots-txt audit fills the gap when Playwright is blocked).
 *
 * Failure: both fail → throw. PSI ok + Playwright fail → ship PSI-only audit.
 */
export async function runCrawl(
  url: URL,
  log: FastifyBaseLogger,
  opts: { sessionId?: string | null } = {},
): Promise<AuditResult> {
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? null;
  log.info({ url: url.href, sessionId }, "crawl: starting (PSI + Playwright, parallel)");

  const [psiSettled, pwSettled] = await Promise.allSettled([
    runLighthouseViaPsi({ url: url.href, sessionId }, log),
    tryPlaywrightCrawl(url, log, sessionId),
  ]);

  const psi = psiSettled.status === "fulfilled" ? psiSettled.value : null;
  const pw = pwSettled.status === "fulfilled" ? pwSettled.value : null;

  if (!psi && !pw) {
    // Both failed — surface PSI's error (the primary path) so the agent's
    // error message reflects what actually failed.
    const psiErr = psiSettled.status === "rejected" ? psiSettled.reason : null;
    const pwErr = pwSettled.status === "rejected" ? pwSettled.reason : null;
    log.error(
      { psiErr: stringifyErr(psiErr), pwErr: stringifyErr(pwErr) },
      "crawl: both PSI and Playwright failed",
    );
    throw psiErr ?? pwErr ?? new Error("crawl failed");
  }

  if (psi && !pw) {
    log.warn(
      { reason: stringifyErr(pwSettled.status === "rejected" ? pwSettled.reason : null) },
      "crawl: Playwright failed; shipping PSI-only audit",
    );
  } else if (!psi && pw) {
    log.warn(
      { reason: stringifyErr(psiSettled.status === "rejected" ? psiSettled.reason : null) },
      "crawl: PSI failed; shipping Playwright-only audit",
    );
  }

  const merged = mergeAuditResults(url.href, psi, pw, Date.now() - startedAt);
  log.info(
    {
      url: url.href,
      ms: merged.durationMs,
      engine: merged.engine.name,
      a11yScore: merged.accessibility.score,
      lcpMs: merged.performance.lcpMs,
    },
    "crawl: complete",
  );
  return merged;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return err === null || err === undefined ? "" : String(err);
}

/**
 * Best-effort Playwright crawl. Returns null on any failure (caller treats
 * absence as "no structural data available"). Errors are NOT re-thrown to
 * the orchestrator — if Playwright fails on a protected site, that's fine,
 * we still have PSI.
 */
async function tryPlaywrightCrawl(
  url: URL,
  log: FastifyBaseLogger,
  sessionId: string | null,
): Promise<AuditResult | null> {
  const startedAt = Date.now();
  try {
    const result = await playwrightCrawl(url, log);
    await logWorkerCall(
      {
        sessionId,
        node: "audit",
        provider: "playwright",
        model: "chromium-131",
        purpose: "crawl",
        latencyMs: Date.now() - startedAt,
        wasBlocked: false,
        resultSummary: `${result.contentArchitecture.wordCount} words · h1×${result.semantic.headingCounts.h1}`,
      },
      log,
    );
    return result;
  } catch (err) {
    await logWorkerCall(
      {
        sessionId,
        node: "audit",
        provider: "playwright",
        model: "chromium-131",
        purpose: "crawl",
        latencyMs: Date.now() - startedAt,
        wasBlocked: true,
        resultSummary: stringifyErr(err).slice(0, 120) || "failed",
      },
      log,
    );
    log.warn(
      { url: url.href, err: stringifyErr(err) },
      "crawl: Playwright failed (expected on WAF-protected sites)",
    );
    return null;
  }
}

/**
 * Merge PSI + Playwright results into a single AuditResult.
 *
 * PSI is canonical for perf + a11y + title/meta; Playwright supplements
 * structural signals (headings, JSON-LD, design fingerprints, word count).
 * Either side may be null; the merge degrades gracefully field-by-field.
 */
function mergeAuditResults(
  url: string,
  psi: AuditResult | null,
  pw: AuditResult | null,
  durationMs: number,
): AuditResult {
  const primary = psi ?? pw!;
  const engineNames: string[] = [];
  if (psi) engineNames.push("google-psi");
  if (pw) engineNames.push("playwright+cheerio");

  return {
    url,
    crawledAt: primary.crawledAt,
    durationMs,
    engine: {
      name: engineNames.join("+"),
      version: psi?.engine.version ?? pw?.engine.version ?? "unknown",
    },
    performance: {
      lcpMs: pickNumber(psi?.performance.lcpMs, pw?.performance.lcpMs),
      fcpMs: pickNumber(psi?.performance.fcpMs, pw?.performance.fcpMs),
      ttfbMs: pickNumber(psi?.performance.ttfbMs, pw?.performance.ttfbMs),
      cls: pickNumber(psi?.performance.cls, pw?.performance.cls),
    },
    accessibility: psi?.accessibility ?? pw?.accessibility ?? { score: null, issues: [] },
    semantic: {
      // Title + meta: PSI's value is reliable; Playwright is a fallback.
      title: psi?.semantic.title ?? pw?.semantic.title ?? null,
      metaDescription:
        psi?.semantic.metaDescription ?? pw?.semantic.metaDescription ?? null,
      // Heading counts only come from Playwright; PSI returns {}.
      headingCounts:
        pw && Object.keys(pw.semantic.headingCounts).length > 0
          ? pw.semantic.headingCounts
          : psi?.semantic.headingCounts ?? {},
      // Structured-data types only come from Playwright.
      structuredDataTypes:
        pw && pw.semantic.structuredDataTypes.length > 0
          ? pw.semantic.structuredDataTypes
          : [],
      // Lang: Playwright extracts the actual value; PSI only flags presence.
      langAttribute: pw?.semantic.langAttribute ?? psi?.semantic.langAttribute ?? null,
    },
    designSignals: pw?.designSignals ?? {
      buttonVariants: 0,
      headingSizes: 0,
      rtlObserved: false,
    },
    aiReadiness: {
      // Union: prefer Playwright's direct probes; PSI's robots-txt audit
      // fills the gap when Playwright is blocked.
      hasSitemap: pw?.aiReadiness.hasSitemap ?? false,
      hasRobotsTxt: (pw?.aiReadiness.hasRobotsTxt ?? psi?.aiReadiness.hasRobotsTxt) ?? false,
      hasOpenGraph: pw?.aiReadiness.hasOpenGraph ?? false,
      score:
        pw?.aiReadiness.score ?? (psi?.aiReadiness.hasRobotsTxt ? 0.25 : null),
    },
    contentArchitecture: pw?.contentArchitecture ?? {
      wordCount: 0,
      navLinkCount: 0,
      primaryCtaAboveFold: null,
    },
    __phase: null,
  };
}

function pickNumber(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a === "number") return a;
  if (typeof b === "number") return b;
  return null;
}

/**
 * Playwright-only crawl. Same logic as before — DOM extraction, computed
 * styles, web vitals, heuristic a11y. Renamed from runCrawl to
 * playwrightCrawl since runCrawl is now the orchestrator.
 */
async function playwrightCrawl(
  url: URL,
  log: FastifyBaseLogger,
): Promise<AuditResult> {
  const startedAt = Date.now();
  log.info({ url: url.href }, "playwright: starting");

  // Launch flags — `--disable-blink-features=AutomationControlled` removes
  // the biggest automation tell. The other flags are stability tweaks that
  // also reduce headless-detection fingerprints.
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: REAL_CHROME_UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      // Realistic browser headers — most WAFs check for these and reject
      // requests missing them (Playwright sends Sec-* by default; we add
      // Accept-Language + Upgrade-Insecure-Requests).
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "upgrade-insecure-requests": "1",
      },
      acceptDownloads: false,
      bypassCSP: false,
    });

    // Patch the most-checked automation signals. Runs before any site script.
    // This is what `playwright-extra` + `puppeteer-extra-plugin-stealth` do
    // for the top 5 detection vectors — we patch manually to avoid the dep.
    await context.addInitScript(() => {
      // 1. navigator.webdriver — the #1 detection signal.
      Object.defineProperty(Navigator.prototype, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
      // 2. navigator.plugins — real Chrome has a non-empty array.
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
      });
      // 3. navigator.languages — real users have multiple.
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
        configurable: true,
      });
      // 4. window.chrome — Playwright headless leaves this undefined; real
      //    Chrome has at least an empty object with `runtime`.
      if (typeof (window as unknown as { chrome?: unknown }).chrome === "undefined") {
        (window as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome = {
          runtime: {},
        };
      }
    });

    const page = await context.newPage();

    // ---- Navigate -------------------------------------------------------
    // `domcontentloaded` not `networkidle` — sites with analytics/chat
    // widgets never settle to truly idle, and we'd burn the full timeout
    // for nothing. We add a best-effort networkidle wait below with a tight
    // cap, then the LCP/CLS observer window.
    let response: PlaywrightResponse | null;
    try {
      response = await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (err) {
      throw new Error(
        `navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response) {
      throw new Error("navigation returned no response");
    }
    if (!response.ok()) {
      // Surface the status code so the agent can compose a useful message
      // (403 = bot-blocked; 5xx = site down; etc.) instead of the generic
      // "the crawl didn't come back" fallback.
      throw new Error(`upstream returned HTTP ${response.status()}`);
    }

    // ---- TOCTOU re-check ------------------------------------------------
    // url-guard validated DNS at request time. Playwright re-resolves at
    // connect time; the result is in response.serverAddr(). If it's private
    // now (DNS rebinding, redirect to private), abort BEFORE we extract.
    const addr = await response.serverAddr();
    if (addr?.ipAddress && isPrivateAddress(addr.ipAddress)) {
      throw new Error(
        `crawl aborted: resolved to non-public address (${addr.ipAddress})`,
      );
    }

    // Best-effort networkidle settle, capped at 5s. Many real sites never
    // reach true idle because of long-polling analytics / chat / SSE.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch {
      // Idle didn't fire within 5s — continue with what we have.
    }

    // LCP/CLS observer window.
    await page.waitForTimeout(1500);

    // ---- Capture Web Vitals --------------------------------------------
    const performanceMetrics = await safeCapture(
      () => captureWebVitals(page),
      log,
      "web-vitals",
      EMPTY_PERFORMANCE,
    );

    // ---- HTML snapshot for Cheerio --------------------------------------
    const html = await page.content();
    const $ = cheerio.load(html);

    // ---- Semantic -------------------------------------------------------
    const semantic = extractSemantic($);

    // ---- Content architecture ------------------------------------------
    const contentArchitecture = extractContentArchitecture($);

    // ---- Design signals -------------------------------------------------
    const designSignals = await safeCapture(
      () => captureDesignSignals(page),
      log,
      "design-signals",
      EMPTY_DESIGN_SIGNALS,
    );

    // ---- AI readiness ---------------------------------------------------
    const aiReadiness = await extractAiReadiness($, url, log);

    // ---- Heuristic accessibility ---------------------------------------
    const accessibility = extractAccessibility($);

    const result: AuditResult = {
      url: url.href,
      crawledAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      engine: { name: "playwright+cheerio", version: "1.0.0" },
      performance: performanceMetrics,
      accessibility,
      semantic,
      designSignals,
      aiReadiness,
      contentArchitecture,
      __phase: null,
    };

    log.info(
      {
        url: url.href,
        ms: result.durationMs,
        wordCount: contentArchitecture.wordCount,
        a11yScore: accessibility.score,
      },
      "playwright: complete",
    );
    return result;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Web Vitals — PerformanceObserver inside the page
// ---------------------------------------------------------------------------

async function captureWebVitals(page: Page): Promise<PerformanceMetrics> {
  const raw = await page.evaluate(async () => {
    return await new Promise<{
      lcpMs: number | null;
      fcpMs: number | null;
      ttfbMs: number | null;
      cls: number | null;
    }>((resolve) => {
      const out = {
        lcpMs: null as number | null,
        fcpMs: null as number | null,
        ttfbMs: null as number | null,
        cls: 0 as number,
      };

      // TTFB + FCP from already-recorded entries.
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (nav) {
        out.ttfbMs = Math.max(0, Math.round(nav.responseStart - nav.requestStart));
      }
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      if (fcp) {
        out.fcpMs = Math.round(fcp.startTime);
      }

      // LCP — final value is the largest observed up to 2s.
      let lcp: PerformanceObserver | null = null;
      try {
        lcp = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as
            | (PerformanceEntry & { renderTime?: number })
            | undefined;
          if (last) {
            out.lcpMs = Math.round(last.renderTime ?? last.startTime);
          }
        });
        lcp.observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        // Browser doesn't support it — leave LCP null.
      }

      // CLS — accumulate over the 2s window, excluding shifts that follow user input.
      let cls: PerformanceObserver | null = null;
      try {
        cls = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
          })[]) {
            if (!entry.hadRecentInput) out.cls += entry.value ?? 0;
          }
        });
        cls.observe({ type: "layout-shift", buffered: true });
      } catch {
        // Leave CLS at 0.
      }

      setTimeout(() => {
        lcp?.disconnect();
        cls?.disconnect();
        resolve({
          lcpMs: out.lcpMs,
          fcpMs: out.fcpMs,
          ttfbMs: out.ttfbMs,
          cls: Math.round(out.cls * 1000) / 1000,
        });
      }, 2000);
    });
  });

  return raw;
}

const EMPTY_PERFORMANCE: PerformanceMetrics = {
  lcpMs: null,
  fcpMs: null,
  ttfbMs: null,
  cls: null,
};

// ---------------------------------------------------------------------------
// Semantic — title, meta, headings, JSON-LD, lang
// ---------------------------------------------------------------------------

function extractSemantic($: cheerio.CheerioAPI): Semantic {
  const headingCounts: Record<string, number> = {};
  for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"] as const) {
    headingCounts[level] = $(level).length;
  }

  const structuredDataTypes = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      for (const t of collectJsonLdTypes(parsed)) structuredDataTypes.add(t);
    } catch {
      // Malformed JSON-LD is common — log nothing, move on.
    }
  });

  const title = ($("title").first().text() || "").trim();
  const metaDescription = (
    $('meta[name="description"]').attr("content") || ""
  ).trim();
  const langAttribute = ($("html").attr("lang") || "").trim();

  return {
    title: title.length > 0 ? title : null,
    metaDescription: metaDescription.length > 0 ? metaDescription : null,
    headingCounts,
    structuredDataTypes: Array.from(structuredDataTypes),
    langAttribute: langAttribute.length > 0 ? langAttribute : null,
  };
}

function collectJsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectJsonLdTypes);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const t = obj["@type"];
    const types: string[] = [];
    if (typeof t === "string") types.push(t);
    if (Array.isArray(t)) {
      for (const x of t) if (typeof x === "string") types.push(x);
    }
    for (const v of Object.values(obj)) {
      for (const x of collectJsonLdTypes(v)) types.push(x);
    }
    return types;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Content architecture — word count, navigation links
// ---------------------------------------------------------------------------

function extractContentArchitecture($: cheerio.CheerioAPI): ContentArchitecture {
  // Mutate a clone, not the original — Cheerio's load() returns a fresh tree
  // and we share it across extractors above. To avoid corrupting them, we
  // build the content tree from $.html() rather than removing nodes here.
  const clone = cheerio.load($.html());
  clone("script, style, noscript, template").remove();
  const text = clone("body").text().replace(/\s+/g, " ").trim();
  const wordCount = text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;

  // Nav links: every <a> under nav/header. Crude but proxy for "global nav".
  const navLinkCount = clone("nav a, header a").length;

  return {
    wordCount,
    navLinkCount,
    // Above-the-fold detection from HTML alone is unreliable. Leaving null is
    // more honest than guessing. Phase 2: probe via page.evaluate() with a
    // viewport-aware reading.
    primaryCtaAboveFold: null,
  };
}

// ---------------------------------------------------------------------------
// Design signals — distinct computed-style fingerprints
// ---------------------------------------------------------------------------

async function captureDesignSignals(page: Page): Promise<DesignSignals> {
  return await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll(
        "button, [role='button'], a.button, a.btn, .btn, .button",
      ),
    );
    const buttonSigs = new Set<string>();
    for (const b of buttons.slice(0, 64)) {
      // Cap to avoid pathological pages
      const cs = window.getComputedStyle(b as Element);
      buttonSigs.add(
        [cs.backgroundColor, cs.color, cs.borderRadius, cs.padding, cs.fontWeight].join("|"),
      );
    }

    const headings = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    );
    const headingSizes = new Set<string>();
    for (const h of headings.slice(0, 64)) {
      const cs = window.getComputedStyle(h as Element);
      headingSizes.add(cs.fontSize);
    }

    const html = document.documentElement;
    const dirAttr = (html.getAttribute("dir") || "").toLowerCase();
    const rtlObserved =
      dirAttr === "rtl" || document.querySelectorAll("[dir='rtl']").length > 0;

    return {
      buttonVariants: buttonSigs.size,
      headingSizes: headingSizes.size,
      rtlObserved,
    };
  });
}

const EMPTY_DESIGN_SIGNALS: DesignSignals = {
  buttonVariants: 0,
  headingSizes: 0,
  rtlObserved: false,
};

// ---------------------------------------------------------------------------
// AI readiness — OG tags + robots.txt + sitemap.xml + JSON-LD presence
// ---------------------------------------------------------------------------

async function extractAiReadiness(
  $: cheerio.CheerioAPI,
  url: URL,
  log: FastifyBaseLogger,
): Promise<AIReadiness> {
  const ogTags = $('meta[property^="og:"]').length;
  const hasOpenGraph = ogTags >= 2;
  const hasStructuredData = $('script[type="application/ld+json"]').length > 0;

  // Probe robots.txt and sitemap.xml on the same origin. Independent fetches
  // with tight timeouts so a slow probe doesn't drag the whole crawl.
  const origin = `${url.protocol}//${url.host}`;
  const [robots, sitemap] = await Promise.all([
    probeUrl(`${origin}/robots.txt`, log),
    probeUrl(`${origin}/sitemap.xml`, log),
  ]);

  let score = 0;
  if (hasOpenGraph) score += 0.25;
  if (hasStructuredData) score += 0.25;
  if (robots) score += 0.25;
  if (sitemap) score += 0.25;

  return {
    hasSitemap: sitemap,
    hasRobotsTxt: robots,
    hasOpenGraph,
    score,
  };
}

async function probeUrl(target: string, log: FastifyBaseLogger): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(target, {
        signal: controller.signal,
        redirect: "follow",
      });
      return res.ok;
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    log.debug({ target, err: (err as Error).message }, "ai-readiness probe failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Heuristic accessibility — Cheerio rule checks
// ---------------------------------------------------------------------------

function extractAccessibility($: cheerio.CheerioAPI): Accessibility {
  const issues: Accessibility["issues"] = [];

  // image-alt: <img> without alt attribute (alt="" is acceptable for
  // decorative images, so we check for the attribute's existence).
  const imgs = $("img");
  let imgWithoutAlt = 0;
  imgs.each((_, el) => {
    if ($(el).attr("alt") === undefined) imgWithoutAlt++;
  });
  if (imgWithoutAlt > 0) {
    issues.push({ rule: "image-alt", severity: "high", count: imgWithoutAlt });
  }

  // link-name: <a> with no accessible name (no text, no aria-label, no
  // child img with alt). Common on icon-only nav links.
  let emptyLinks = 0;
  $("a").each((_, el) => {
    const $el = $(el);
    if ($el.attr("aria-label") || $el.attr("title")) return;
    const txt = $el.text().trim();
    if (txt.length > 0) return;
    const imgAlt = $el.find("img[alt]").filter((_i, img) => ($(img).attr("alt") ?? "").trim().length > 0).length;
    if (imgAlt > 0) return;
    emptyLinks++;
  });
  if (emptyLinks > 0) {
    issues.push({ rule: "link-name", severity: "high", count: emptyLinks });
  }

  // label: form inputs without an accessible name.
  let unlabeledInputs = 0;
  $(
    "input[type='text'], input[type='email'], input[type='password'], " +
      "input[type='search'], input[type='tel'], input[type='url'], " +
      "input[type='number'], textarea, select",
  ).each((_, el) => {
    const $el = $(el);
    if ($el.attr("aria-label") || $el.attr("aria-labelledby")) return;
    const id = $el.attr("id");
    if (id && $(`label[for="${cssEscape(id)}"]`).length > 0) return;
    if ($el.closest("label").length > 0) return;
    unlabeledInputs++;
  });
  if (unlabeledInputs > 0) {
    issues.push({ rule: "label", severity: "high", count: unlabeledInputs });
  }

  // html-has-lang
  const lang = ($("html").attr("lang") || "").trim();
  if (lang.length === 0) {
    issues.push({ rule: "html-has-lang", severity: "medium", count: 1 });
  }

  // page-has-heading-one — exactly one h1 is the calibrated norm.
  const h1Count = $("h1").length;
  if (h1Count === 0) {
    issues.push({ rule: "page-has-heading-one", severity: "medium", count: 1 });
  } else if (h1Count > 1) {
    issues.push({
      rule: "page-has-multiple-heading-one",
      severity: "low",
      count: h1Count,
    });
  }

  // bypass — landmark / skip link presence (very common miss).
  const hasSkipLink = $("a[href^='#'], a.skip, a[class*='skip']").length > 0;
  if (!hasSkipLink) {
    issues.push({ rule: "skip-link-absent", severity: "low", count: 1 });
  }

  // Score = 100 - weighted issues (cap floor at 0).
  const severityWeight: Record<"low" | "medium" | "high" | "critical", number> = {
    low: 2,
    medium: 6,
    high: 12,
    critical: 25,
  };
  const deduction = issues.reduce(
    (sum, i) => sum + severityWeight[i.severity] * Math.min(i.count, 5),
    0,
  );
  const score = Math.max(0, 100 - deduction);

  return { score, issues };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a capture step that may throw; on failure log and fall through to the
 * provided default. We'd rather return a partial AuditResult than fail the
 * whole crawl because one signal couldn't be extracted.
 */
async function safeCapture<T>(
  fn: () => Promise<T>,
  log: FastifyBaseLogger,
  step: string,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.warn({ step, err: (err as Error).message }, "crawl: capture step failed");
    return fallback;
  }
}

/** Escape a string for use inside a CSS attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/(["\\\]])/g, "\\$1");
}
