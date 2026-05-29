import type { FastifyBaseLogger } from "fastify";
import { getWorkerSupabase } from "./supabase.js";

/**
 * Worker → model_calls logger.
 *
 * The Next.js side already logs every Anthropic + Ollama call into the
 * `model_calls` table via src/lib/models/call-log.ts. The worker makes its
 * own external calls (Google PSI for Lighthouse, headless Chromium via
 * Playwright) — those were invisible in the admin session timeline until
 * now. This module routes them into the same table so the /admin/sessions
 * detail view sees PSI + Playwright inline with the Claude + Ollama calls,
 * with matching latency / status / a small response summary.
 *
 * Schema reuse (no migration required):
 *   provider  →  "google-psi" | "playwright"
 *   model     →  "lighthouse-v6" | "chromium-131" (descriptive)
 *   purpose   →  "lighthouse" | "crawl"
 *   tokens    →  null (these aren't LLMs)
 *   cost_usd  →  0 (both are free at our volumes)
 *   latency_ms → real elapsed wall-clock
 *   was_blocked → set when the upstream HTTP returned >= 400
 *
 * Failures are SWALLOWED — observability must never break the request path.
 * Worst case the admin sees a missing row; the audit still completes.
 */

export interface WorkerCallRow {
  sessionId: string | null;
  node: string;
  provider: "google-psi" | "playwright";
  model: string;
  purpose: "lighthouse" | "crawl";
  latencyMs: number;
  wasBlocked: boolean;
  /**
   * Optional human-readable summary stored in the model name slot
   * (no dedicated column for this — schema purity matters less here than
   * not requiring a fresh migration).
   */
  resultSummary?: string;
}

export async function logWorkerCall(
  row: WorkerCallRow,
  log: FastifyBaseLogger,
): Promise<void> {
  const supabase = getWorkerSupabase();
  if (!supabase) {
    log.debug({ row }, "[worker-call] supabase unavailable; skipping log");
    return;
  }
  // Tack the summary onto the model column so it shows in the admin
  // timeline without a schema change. Capped to 80 chars so the column
  // (text) doesn't accidentally become a blob.
  const modelLabel = row.resultSummary
    ? `${row.model} · ${row.resultSummary}`.slice(0, 200)
    : row.model;
  const { error } = await supabase.from("model_calls").insert({
    session_id: row.sessionId,
    node: row.node,
    provider: row.provider,
    model: modelLabel,
    purpose: row.purpose,
    input_tokens: null,
    output_tokens: null,
    cost_usd: 0,
    latency_ms: row.latencyMs,
    was_blocked: row.wasBlocked,
  });
  if (error) {
    log.warn({ err: error.message }, "[worker-call] insert failed");
  }
}
