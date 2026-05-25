import { getCurrentAdmin } from "@/server/admin/auth";
import { resetTodayQuota } from "@/server/settings";

/**
 * POST /api/admin/quota/reset
 *
 * Wipes today's per-IP turn + audit counters across every visitor for the
 * current UTC day. Used by the admin "Reset today's quota" button to
 * unblock demos that hit the cap.
 *
 * Returns the number of rows deleted so the admin gets a confirmation
 * receipt. Yesterday's rows are untouched — they're still useful history.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const deleted = await resetTodayQuota();
    // eslint-disable-next-line no-console
    console.info(
      `[admin] ${admin.email} reset today's IP quota — ${deleted} rows cleared`,
    );
    return Response.json({ deleted });
  } catch (err) {
    return Response.json(
      { error: "reset_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
