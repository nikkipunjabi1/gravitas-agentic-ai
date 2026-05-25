import { type NextRequest, NextResponse } from "next/server";
import { getCurrentAdmin } from "@/server/admin/auth";

/**
 * POST /api/admin/kb/refresh — admin-triggered KB refresh.
 *
 * Auth: must be a signed-in admin. We re-check here even though middleware
 * already gates this route — admin actions get an extra belt at API level.
 *
 * Forwards to the worker's POST /kb/refresh with the worker shared secret,
 * stamping `triggeredBy` as `admin:<email>` so the kb_ingest_runs row links
 * to who pressed the button.
 *
 * Body: `{ reseed?: boolean }`.
 *
 * Fire-and-forget: returns 202 immediately if the worker accepted the
 * request, then the worker holds the connection while the run executes.
 * (The admin UI polls /api/admin/kb/runs/current for progress.) We DON'T
 * await the worker response here because the worker holds open until ingest
 * completes — that would block this route for ~10s.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const workerUrl = process.env.CRAWL_WORKER_URL;
  const workerSecret = process.env.CRAWL_WORKER_SHARED_SECRET;
  if (!workerUrl || !workerSecret || workerSecret.length < 16) {
    return NextResponse.json(
      {
        error: "worker_not_configured",
        detail:
          "Set CRAWL_WORKER_URL and CRAWL_WORKER_SHARED_SECRET (≥16 chars) in .env.local, then start `pnpm dev:worker`.",
      },
      { status: 503 },
    );
  }

  let body: { reseed?: boolean };
  try {
    body = ((await req.json()) ?? {}) as { reseed?: boolean };
  } catch {
    body = {};
  }

  // Fire the worker request asynchronously — we want to return to the admin
  // UI quickly so it can start polling. The worker writes its own
  // kb_ingest_runs row, which the UI then reads.
  void fetch(`${workerUrl.replace(/\/$/, "")}/kb/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${workerSecret}`,
    },
    body: JSON.stringify({
      reseed: Boolean(body.reseed),
      triggeredBy: `admin:${admin.email}`,
    }),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[/api/admin/kb/refresh] worker call failed", err);
  });

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}
