import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdmin } from "@/server/admin/auth";
import { setKbNotificationSettings } from "@/server/admin/kb";

/**
 * POST /api/admin/kb/notifications — persist KB ingest notification settings.
 *
 * Body: any subset of:
 *   - emails:           string[]
 *   - notifyOnSuccess:  boolean
 *   - notifyOnFailure:  boolean
 *
 * Partial updates are supported so toggling one field doesn't require
 * sending the full settings shape. The server-side setter de-dupes +
 * lowercases emails before persisting.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  notifyOnSuccess: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", detail: (err as Error).message },
      { status: 400 },
    );
  }
  try {
    await setKbNotificationSettings(parsed);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: "save_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
