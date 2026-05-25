import { z } from "zod";
import { listSessionMessages } from "@/server/sessions";
import { isSuspended } from "@/lib/guardrails";

/**
 * GET /api/chat/history?sessionId=<uuid>
 *
 * Reads-only endpoint that returns prior visitor + assistant messages so the
 * Co-Pilot UI can resume an in-progress conversation when the visitor comes
 * back (browser localStorage holds the session id for up to 7 days — see
 * `useSessionId` in copilot-shell.tsx).
 *
 * Quotas: this is a READ. It does NOT consume an IP turn or audit. Cheap
 * enough to skip rate-limiting; the IP quota guards expensive *writes*
 * (model calls in POST /api/chat) and we don't want resumes throttled.
 *
 * Suspended sessions (3-strike profanity gate): we return an empty history
 * + `suspended: true` so the client can show a non-recovery banner instead
 * of seeding a chat the server will refuse anyway.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const QuerySchema = z.object({
  sessionId: z.string().uuid(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    sessionId: url.searchParams.get("sessionId"),
  });
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_query", detail: parsed.error.issues[0]?.message ?? "invalid sessionId" },
      { status: 400 },
    );
  }

  const { sessionId } = parsed.data;
  const suspended = isSuspended(sessionId);
  const rows = suspended ? [] : await listSessionMessages(sessionId);

  return Response.json({
    sessionId,
    suspended,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      ts: r.ts,
    })),
  });
}
