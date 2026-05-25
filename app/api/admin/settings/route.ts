import { z } from "zod";
import { getCurrentAdmin } from "@/server/admin/auth";
import { SETTING_DEFAULTS, setSetting, type SettingKey } from "@/server/settings";

/**
 * POST /api/admin/settings
 *
 * Body: { key: SettingKey, value: number }
 *
 * Validates the caller is signed in as an admin (the middleware already
 * gates /admin/* and any /api/admin/* — but we re-check here so a
 * compromised middleware bypass can't write arbitrary settings).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  key: z.enum(Object.keys(SETTING_DEFAULTS) as [SettingKey, ...SettingKey[]]),
  value: z.number().int().min(0),
});

export async function POST(req: Request) {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof Body>;
  try {
    const body = (await req.json()) as unknown;
    parsed = Body.parse(body);
  } catch (err) {
    return Response.json(
      { error: "invalid_body", detail: (err as Error).message },
      { status: 400 },
    );
  }

  try {
    const next = await setSetting(parsed.key, parsed.value, admin.email);
    return Response.json({ key: parsed.key, value: next });
  } catch (err) {
    return Response.json(
      { error: "save_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
