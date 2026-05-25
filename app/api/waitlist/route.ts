import { z } from "zod";
import { getSupabaseAdminClient, isSupabaseConfigured } from "@/server/supabase/client";

/**
 * POST /api/waitlist — captures an email for the daily-cap "we're back" list.
 *
 * Inserts into `waitlist` (Supabase) with the originating session, the URL the
 * visitor intended to audit, and the source tag. Phase 2 will send the
 * "we're back" email; Phase 1 only captures.
 *
 * Returns 200 on success (even on duplicate — we treat duplicate-email as
 * "you're already on the list" rather than an error to surface).
 *
 * If Supabase isn't configured, the endpoint returns 200 with a `persisted:
 * false` payload so the UI's success state still works — the captured email
 * is logged structured but not stored. Phase 2 swap: refuse 503 instead.
 *
 * Schema validation is intentionally tighter than the client-side check:
 *   - email RFC-5322-ish via zod's email validator
 *   - sessionId is the UUID the canvas card carries (used to link to the
 *     `sessions` row for audit-trail purposes)
 *   - intendedUrl is nullable
 *   - source is an enum we know about
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email().max(254),
  sessionId: z.string().uuid(),
  intendedUrl: z.string().url().nullable().optional(),
  source: z.enum(["daily_cap"]),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>;
  try {
    const raw = (await req.json()) as unknown;
    parsed = Body.parse(raw);
  } catch (err) {
    return Response.json(
      { error: "invalid_body", detail: (err as Error).message },
      { status: 400 },
    );
  }

  if (!isSupabaseConfigured()) {
    // Best-effort: log + acknowledge. Dev environments without Supabase still
    // exercise the form flow end-to-end.
    // eslint-disable-next-line no-console
    console.warn(
      "[waitlist] Supabase not configured — captured email NOT persisted:",
      JSON.stringify({
        email: redactEmail(parsed.email),
        source: parsed.source,
        sessionId: parsed.sessionId,
      }),
    );
    return Response.json({ ok: true, persisted: false });
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    return Response.json({ ok: true, persisted: false });
  }

  // Insert. If a duplicate (same email + same day + same source) sneaks in,
  // we don't surface that to the user — they're "on the list" either way.
  const { error } = await client.from("waitlist").insert({
    email: parsed.email.toLowerCase(),
    session_id: parsed.sessionId,
    intended_url: parsed.intendedUrl ?? null,
    source: parsed.source,
  });
  if (error) {
    // 23505 = unique-violation; treat as success from the visitor's POV.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return Response.json({ ok: true, persisted: true, duplicate: true });
    }
    // eslint-disable-next-line no-console
    console.error("[waitlist] insert failed:", error.message);
    return Response.json(
      { error: "insert_failed", detail: error.message },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, persisted: true });
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
