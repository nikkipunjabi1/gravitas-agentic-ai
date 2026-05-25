import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentAdmin } from "@/server/admin/auth";
import { setKbCadence } from "@/server/admin/kb";

/**
 * POST /api/admin/kb/cadence — persist the refresh cadence.
 *
 * Body: `{ hours: 24 | 168 | 720 | null }`. The validator is permissive of
 * other positive integers in case we want hourly cadences later, but the
 * UI only offers the four canonical values.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  hours: z.number().int().positive().nullable(),
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
    await setKbCadence(parsed.hours);
    return NextResponse.json({ ok: true, hours: parsed.hours });
  } catch (err) {
    return NextResponse.json(
      { error: "save_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
