import "server-only";
import type { CallLog, ModelCallRow } from "@/lib/models/call-log";
import { getSupabaseAdminClient } from "./supabase/client";

/**
 * Supabase-backed CallLog. Inserts each call into model_calls.
 *
 * Failures are logged but never thrown to the caller — a logging failure must
 * not break the user-facing turn. (The router caller wraps in a try/catch
 * indirectly: a thrown CallLog would cascade back through router.complete()
 * and ruin the conversation.) Better to lose a log row than a session.
 */
export class SupabaseCallLog implements CallLog {
  constructor() {
    if (!getSupabaseAdminClient()) {
      throw new Error("SupabaseCallLog requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    }
  }

  async record(row: ModelCallRow): Promise<void> {
    const client = getSupabaseAdminClient();
    if (!client) return; // defence — shouldn't happen post-constructor
    const { error } = await client.from("model_calls").insert({
      session_id: row.sessionId,
      node: row.node,
      provider: row.provider,
      model: row.model,
      purpose: row.purpose,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_usd: row.costUsd,
      latency_ms: row.latencyMs,
      was_blocked: row.wasBlocked,
      ts: row.ts,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[model_calls] insert failed", error.message, {
        provider: row.provider,
        model: row.model,
        purpose: row.purpose,
      });
    }
  }
}
