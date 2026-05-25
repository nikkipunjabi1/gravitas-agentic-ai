import "server-only";
import { AuditResult, type AuditResult as AuditResultT } from "@/agents/state";

/**
 * crawl-url — HTTP call from the agent (Next.js) to the worker (Fastify).
 *
 * Sends `Authorization: Bearer ${CRAWL_WORKER_SHARED_SECRET}` per
 * docs/ARCHITECTURE.md → Security. Validates the response against the agent's
 * own AuditResult schema; on schema mismatch we treat it as a hard error
 * rather than letting bad data corrupt the downstream graph state.
 *
 * Timeout: 45s. The worker's own timeout is 30s navigation + ~5s settle, so
 * 45s leaves room for the Fastify response + transport overhead.
 *
 * Returns a discriminated result so the Audit node can branch on failure
 * without try/catch noise everywhere.
 */

export type CrawlOk = { ok: true; result: AuditResultT };
export type CrawlErr = {
  ok: false;
  error: string;
  reason: "config" | "network" | "auth" | "remote" | "parse";
  status?: number;
};
export type CrawlOutcome = CrawlOk | CrawlErr;

export async function crawlUrl(opts: {
  url: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<CrawlOutcome> {
  const base = process.env.CRAWL_WORKER_URL;
  const secret = process.env.CRAWL_WORKER_SHARED_SECRET;
  if (!base || !secret || secret.length < 16) {
    return {
      ok: false,
      reason: "config",
      error:
        "crawl worker not configured: set CRAWL_WORKER_URL and CRAWL_WORKER_SHARED_SECRET (≥ 16 chars)",
    };
  }

  // Outer budget for the worker call. Worker internals: PSI ≤ 90s (Google
  // sometimes takes ≥ 40s on heavy enterprise sites) + Playwright ≤ 30s
  // navigation + ~7s settle/observers. They run in parallel, so the
  // wall-clock max is roughly the PSI budget; 120s gives ~30s of headroom
  // for transport + serialisation without making real failures lurk forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("crawl timeout"), 120_000);
  const linkedSignal = opts.signal
    ? linkAbort(opts.signal, controller)
    : controller.signal;

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}/crawl`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        url: opts.url,
        sessionId: opts.sessionId,
      }),
      signal: linkedSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: "network",
      error: (err as Error).message,
    };
  }
  clearTimeout(timer);

  if (res.status === 401) {
    return { ok: false, reason: "auth", error: "worker rejected the shared secret", status: 401 };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason: "remote",
      error: `worker returned ${res.status}: ${detail}`,
      status: res.status,
    };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, reason: "parse", error: `non-JSON response: ${(err as Error).message}` };
  }

  // Worker doesn't set `findings`; agent derives them. Add an empty array
  // before validation so the agent-side schema (which requires findings) parses.
  const enriched =
    payload && typeof payload === "object"
      ? { findings: [], ...(payload as Record<string, unknown>) }
      : payload;

  const parsed = AuditResult.safeParse(enriched);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "parse",
      error: `schema mismatch: ${parsed.error.issues.map((i) => i.path.join(".") + ":" + i.message).slice(0, 5).join("; ")}`,
    };
  }
  return { ok: true, result: parsed.data };
}

function linkAbort(external: AbortSignal, internal: AbortController): AbortSignal {
  if (external.aborted) internal.abort(external.reason);
  else external.addEventListener("abort", () => internal.abort(external.reason), { once: true });
  return internal.signal;
}
