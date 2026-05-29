import { z } from "zod";
import { getCurrentAdmin } from "@/server/admin/auth";
import { setSetting, SETTING_KEYS, type SettingKey } from "@/server/settings";

/**
 * POST /api/admin/settings
 *
 * Body: { key: SettingKey, value: unknown }
 *
 * Per-key validation runs here — different settings have different shape
 * constraints (numbers for rate limits, hex colours for embed colour,
 * non-empty strings for prompts, string arrays for KB whitelist).
 *
 * Auth: the middleware already gates /admin/* and any /api/admin/* — but
 * we re-check getCurrentAdmin here so a compromised middleware bypass
 * can't write arbitrary settings.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEY_ENUM = z.enum(Object.keys(SETTING_KEYS) as [SettingKey, ...SettingKey[]]);

const Body = z.object({
  key: KEY_ENUM,
  value: z.unknown(),
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

  const validation = validateForKey(parsed.key, parsed.value);
  if (!validation.ok) {
    return Response.json(
      { error: "invalid_value", detail: validation.message },
      { status: 400 },
    );
  }

  try {
    const next = await setSetting(parsed.key, validation.value, admin.email);
    return Response.json({ key: parsed.key, value: next });
  } catch (err) {
    return Response.json(
      { error: "save_failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Per-key validation rules. Add a case here whenever a new key is added
 * to SETTING_KEYS — otherwise it falls through to the catch-all that
 * accepts any JSON-serialisable value.
 */
function validateForKey(
  key: SettingKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  // Numbers — rate limits + embed dimensions.
  if (
    key === "ip_daily_turn_limit" ||
    key === "ip_daily_audit_limit" ||
    key === "embed_width" ||
    key === "embed_height"
  ) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, message: "expected a non-negative integer" };
    }
    const max =
      key === "ip_daily_turn_limit"
        ? 1000
        : key === "ip_daily_audit_limit"
          ? 100
          : 2000; // embed dimensions
    if (n > max) {
      return { ok: false, message: `value exceeds maximum (${max})` };
    }
    return { ok: true, value: n };
  }

  // Hex colour strings.
  if (key === "embed_primary_color" || key === "embed_text_color") {
    if (typeof value !== "string") {
      return { ok: false, message: "expected a string" };
    }
    if (!/^#[0-9a-fA-F]{3,8}$/.test(value)) {
      return { ok: false, message: "expected a hex colour (e.g. #0B0B0F)" };
    }
    return { ok: true, value };
  }

  // Enum strings.
  if (key === "embed_position") {
    if (value !== "bottom-right" && value !== "bottom-left") {
      return { ok: false, message: "expected 'bottom-right' or 'bottom-left'" };
    }
    return { ok: true, value };
  }

  // Email — branding contact.
  if (key === "branding_contact_email") {
    if (typeof value !== "string") {
      return { ok: false, message: "expected a string" };
    }
    if (value.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return { ok: false, message: "expected a valid email or an empty string" };
    }
    return { ok: true, value };
  }

  // URL — KB sitemap.
  if (key === "kb_sitemap_url") {
    if (typeof value !== "string") {
      return { ok: false, message: "expected a string" };
    }
    if (value.length > 0) {
      try {
        new URL(value);
      } catch {
        return { ok: false, message: "expected a valid URL" };
      }
    }
    return { ok: true, value };
  }

  // String arrays — KB whitelist patterns.
  if (key === "kb_whitelist_patterns") {
    if (!Array.isArray(value)) {
      return { ok: false, message: "expected an array of strings" };
    }
    if (value.length > 200) {
      return { ok: false, message: "too many entries (max 200)" };
    }
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0) {
        return { ok: false, message: "each entry must be a non-empty string" };
      }
      if (!entry.startsWith("/")) {
        return { ok: false, message: `entry "${entry}" must start with /` };
      }
    }
    return { ok: true, value };
  }

  // Free-form strings (prompts, branding text, launcher text).
  // Cap at 32 KB so a runaway paste doesn't blow up the JSONB column.
  if (typeof value === "string") {
    if (value.length > 32_768) {
      return { ok: false, message: "value too long (max 32 KB)" };
    }
    return { ok: true, value };
  }

  // Unknown type for unknown key — store as-is.
  return { ok: true, value };
}
