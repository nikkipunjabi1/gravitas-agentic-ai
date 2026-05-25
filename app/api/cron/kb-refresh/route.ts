import { type NextRequest } from "next/server";

/**
 * GET /api/cron/kb-refresh — daily KB ingest trigger.
 *
 * Forwards to the worker's POST /kb/refresh endpoint with the worker shared
 * secret. The actual sitemap diff + chunk + embed + upsert all happens in
 * the worker (see worker/src/kb-ingest.ts).
 *
 * Schedule: 04:00 UTC daily (docs/ARCHITECTURE.md → Gravitas knowledge base).
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}. Production cron sends it; the
 * route forwards a DIFFERENT bearer to the worker (CRAWL_WORKER_SHARED_SECRET).
 *
 * Body forwarded: `{ reseed: false }`. Use the `?reseed=true` query param to
 * force a full re-crawl (rare; CLI `pnpm kb:reseed` is the usual path).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const workerUrl = process.env.CRAWL_WORKER_URL;
  const workerSecret = process.env.CRAWL_WORKER_SHARED_SECRET;
  if (!workerUrl || !workerSecret || workerSecret.length < 16) {
    return Response.json(
      { error: "worker_not_configured" },
      { status: 503 },
    );
  }

  const reseed = req.nextUrl.searchParams.get("reseed") === "true";

  const t = Date.now();
  let res: Response;
  try {
    res = await fetch(`${workerUrl.replace(/\/$/, "")}/kb/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({ reseed }),
    });
  } catch (err) {
    return Response.json(
      {
        error: "worker_unreachable",
        detail: (err as Error).message,
        latencyMs: Date.now() - t,
      },
      { status: 502 },
    );
  }

  const latencyMs = Date.now() - t;
  const payload = await safeJson(res);
  if (!res.ok) {
    return Response.json(
      { error: "worker_error", status: res.status, latencyMs, payload },
      { status: 502 },
    );
  }
  return Response.json({ ok: true, latencyMs, stats: payload });
}

function authorize(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return false;
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
