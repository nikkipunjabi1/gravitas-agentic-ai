import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/server/admin/auth";
import { getCurrentRun } from "@/server/admin/kb";

/**
 * GET /api/admin/kb/runs/current — currently-running KB ingest, or null.
 *
 * The /admin/kb page polls this every 2s while a run is in flight. Returns
 * the full run row (started_at, pages_planned/fetched/errored, etc.) so the
 * UI can render a progress bar without a second round-trip.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const run = await getCurrentRun();
  return NextResponse.json({ run });
}
