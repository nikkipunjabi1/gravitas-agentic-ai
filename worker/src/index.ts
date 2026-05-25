// IMPORTANT: env-loader MUST be the first import. It populates process.env
// from the repo-root .env.local before any other module reads it (Supabase
// client, auth, crawl, kb-ingest all consume env at import time).
import "./env-loader.js";

import Fastify from "fastify";
import { CrawlRequest, AuditResult, ErrorResponse } from "./types.js";
import { authPreHandler } from "./auth.js";
import { sanitiseUrl } from "./url-guard.js";
import { runCrawl } from "./crawl.js";
import { runIngest } from "./kb-ingest.js";

/**
 * Gravitas crawl worker — Fastify entrypoint.
 *
 * Phase 0 routes:
 *   GET  /health        — liveness, behind shared-secret guard
 *   POST /crawl         — accepts { url }, returns stub AuditResult
 *
 * Phase 1+ adds (in this same process):
 *   POST /kb/refresh    — sitemap-driven KB incremental crawl
 *   POST /kb/reseed     — full re-crawl (CLI-triggered via kb:reseed)
 *
 * Runtime: Node 22+. The worker is NOT bundled into Next.js — Playwright
 * doesn't run on edge or Vercel functions, which is why this service exists.
 */

const PORT = Number(process.env.WORKER_PORT ?? 8787);
const HOST = process.env.WORKER_HOST ?? "0.0.0.0";

const app = Fastify({
  // Plain pino JSON logs in every environment — `pino-pretty` adds a runtime
  // dep we don't want to install just for prettier dev logs. Pipe to `jq` if
  // you want them readable: `pnpm dev:worker | jq .`
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  // Reasonable body size — visitor URLs are small. Phase 1 KB endpoints may
  // need to raise this; do so per-route, not globally.
  bodyLimit: 16 * 1024,
});

// Apply the shared-secret guard to every route. /health intentionally
// included — admin polls it with the secret per docs/ADMIN_PANEL.md.
app.addHook("preHandler", authPreHandler);

// ---------- Routes ---------------------------------------------------------

app.get("/health", async () => {
  return {
    status: "ok",
    uptimeMs: Math.round(process.uptime() * 1000),
    version: "0.0.0",
    engine: "playwright+cheerio",
  };
});

app.post("/crawl", async (req, reply) => {
  // ---- Validate body ----------------------------------------------------
  const parsed = CrawlRequest.safeParse(req.body);
  if (!parsed.success) {
    const err: ErrorResponse = {
      error: "invalid_body",
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
    reply.code(400).send(err);
    return;
  }

  // ---- Sanitise URL (SSRF guard) ---------------------------------------
  const guard = await sanitiseUrl(parsed.data.url);
  if (!guard.ok) {
    req.log.warn({ url: parsed.data.url, reason: guard.reason }, "url rejected");
    const err: ErrorResponse = { error: guard.reason };
    reply.code(400).send(err);
    return;
  }

  // ---- Run the crawl (Phase 0: stub) -----------------------------------
  try {
    const result: AuditResult = await runCrawl(guard.url, req.log);
    reply.code(200).send(result);
  } catch (err) {
    req.log.error({ err }, "crawl failed");
    const body: ErrorResponse = {
      error: "crawl_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
    reply.code(500).send(body);
  }
});

/**
 * POST /kb/refresh — incremental KB ingest (Phase 1).
 *
 * Triggered by the daily cron at 04:00 UTC (docs/ARCHITECTURE.md → KB
 * pipeline). Body accepts an optional `{ reseed: boolean }` to force a full
 * re-crawl; default is incremental against `kb_documents`.
 *
 * Returns ingest stats; the cron / admin panel can render them. Long jobs
 * (~10s for the Gravitas KB) run inline — Fastify holds the connection.
 * If runtime balloons in Phase 2, swap for a job-queue pattern.
 */
app.post("/kb/refresh", async (req, reply) => {
  const body = (req.body ?? {}) as { reseed?: boolean; triggeredBy?: string };
  try {
    const stats = await runIngest({
      reseed: Boolean(body.reseed),
      triggeredBy: body.triggeredBy ?? "cron",
      log: {
        info: (msg, meta) => req.log.info({ meta }, msg),
        warn: (msg, meta) => req.log.warn({ meta }, msg),
        error: (msg, meta) => req.log.error({ meta }, msg),
      },
    });
    reply.code(200).send(stats);
  } catch (err) {
    req.log.error({ err }, "kb refresh failed");
    const errBody: ErrorResponse = {
      error: "kb_refresh_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
    reply.code(500).send(errBody);
  }
});

// 404 fallback — keeps the auth guard from being the last word for bad paths.
app.setNotFoundHandler((_req, reply) => {
  const body: ErrorResponse = { error: "not_found" };
  reply.code(404).send(body);
});

// ---------- Lifecycle ------------------------------------------------------

async function start(): Promise<void> {
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`crawl worker listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err, "failed to start crawl worker");
    process.exit(1);
  }
}

// Graceful shutdown on SIGINT / SIGTERM — Railway sends SIGTERM on redeploy.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info({ sig }, "received signal — shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, "error during shutdown");
      process.exit(1);
    }
  });
}

void start();
