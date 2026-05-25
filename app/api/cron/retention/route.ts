import { type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * GET /api/cron/retention — nightly retention sweep.
 *
 * Deletes rows older than SESSION_RETENTION_DAYS from:
 *   - sessions (cascades to messages, model_calls, ui_actions_emitted via FK)
 * Aggregated tables kept indefinitely:
 *   - cost_ledger (no PII)
 *   - kb_documents (the manifest, not the chunks)
 *   - waitlist (small set, manual review)
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}. Without it, 401.
 * Production cron schedules a daily hit (Railway cron or external scheduler);
 * Phase 2 may move to a Supabase Edge Function for tighter latency.
 *
 * Returns counts so the schedule's logs show what got swept.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const retentionDays = Math.max(1, Number(process.env.SESSION_RETENTION_DAYS ?? 90));
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Delete from sessions; cascade handles messages / model_calls /
  // ui_actions_emitted via the FK ON DELETE CASCADE clauses in the migration.
  const { count, error } = await client
    .from("sessions")
    .delete({ count: "exact" })
    .lt("started_at", cutoff);

  if (error) {
    return Response.json(
      { error: "retention_sweep_failed", detail: error.message },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    retentionDays,
    cutoff,
    sessionsDeleted: count ?? 0,
  });
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
