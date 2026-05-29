import "server-only";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * Runtime-tunable system settings (Supabase `system_settings` table).
 *
 * What lives here vs. what lives in env:
 *
 *   env (.env.local / Railway)   one-time wiring — API keys, base URLs,
 *                                feature toggles set at deploy time.
 *
 *   system_settings (this file)  values an admin will reasonably want to
 *                                change at runtime without a redeploy —
 *                                rate-limit caps, embed widget styling,
 *                                KB sitemap, agent system prompts.
 *
 * Reads are cached app-side for SETTINGS_TTL_MS so we don't hammer Postgres
 * on every chat turn. Writes invalidate the cache process-locally; other
 * Next.js instances pick up the change within ~TTL.
 *
 * Fallback: when Supabase isn't configured (dev clones with no env vars)
 * OR the key is unset OR malformed, every read returns the caller-supplied
 * default. The app stays functional with zero seeded settings — admins
 * opt-in to a value by saving it.
 */

const SETTINGS_TTL_MS = 60_000;

interface CachedValue {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CachedValue>();

/**
 * Keys are declared centrally — gives TypeScript a closed list for the
 * admin form, and avoids typos at call sites.
 *
 * Grouping below mirrors the admin Settings tabs (`/admin/settings`).
 */
export const SETTING_KEYS = {
  // ---- Rate limits (existing — P1.11) -------------------------------
  ip_daily_turn_limit: "ip_daily_turn_limit",
  ip_daily_audit_limit: "ip_daily_audit_limit",

  // ---- Branding (P1.16) ---------------------------------------------
  /** Used in prompts as {{brand_name}}, in headers, and in admin chrome. */
  branding_brand_name: "branding_brand_name",
  branding_contact_name: "branding_contact_name",
  branding_contact_role: "branding_contact_role",
  branding_contact_email: "branding_contact_email",
  branding_contact_phone: "branding_contact_phone",

  // ---- Embed widget (P1.16) -----------------------------------------
  embed_launcher_text: "embed_launcher_text",
  embed_primary_color: "embed_primary_color",
  embed_text_color: "embed_text_color",
  embed_position: "embed_position", // "bottom-right" | "bottom-left"
  embed_width: "embed_width",
  embed_height: "embed_height",

  // ---- KB ingest (P1.16) --------------------------------------------
  kb_sitemap_url: "kb_sitemap_url",
  kb_whitelist_patterns: "kb_whitelist_patterns", // string[]

  // ---- Agent prompts (P1.16) ----------------------------------------
  prompt_discovery_voice_base: "prompt_discovery_voice_base",
  prompt_discovery_problem: "prompt_discovery_problem",
  prompt_discovery_kb_grounded: "prompt_discovery_kb_grounded",
  prompt_discovery_kb_empty: "prompt_discovery_kb_empty",
  prompt_discovery_meta: "prompt_discovery_meta",
  prompt_discovery_offtopic: "prompt_discovery_offtopic",
  prompt_audit_narration: "prompt_audit_narration",
  prompt_strategy_json: "prompt_strategy_json",
  prompt_strategy_narration: "prompt_strategy_narration",
  prompt_output_close: "prompt_output_close",

  // ---- Feature flags (P1.18) ----------------------------------------
  // Master + sub-switches so a bespoke deployment can ship as
  // "chatbot only" (no audit pipeline at all) OR keep the audit path
  // active but disable one of its two data sources. When the master
  // switch is off the sub-switches don't matter — graph short-circuits
  // before the worker is called.
  feature_audit_enabled: "feature_audit_enabled",
  feature_audit_use_psi: "feature_audit_use_psi",
  feature_audit_use_playwright: "feature_audit_use_playwright",

  // ---- Visitor-visible copy (P1.19) ---------------------------------
  // Short disclaimer rendered at the foot of the chat surface. Default
  // lives in code (src/server/runtime-config.ts → getUiDisclaimer);
  // empty value here = use the default, otherwise admin override wins.
  ui_disclaimer_text: "ui_disclaimer_text",
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;

export interface SettingRow {
  key: SettingKey;
  value: unknown;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Read a single setting with a typed fallback. The fallback shape decides
 * the return type — admins can store any JSON-serialisable value.
 *
 * If the row is missing OR the value is null OR the cached value's type
 * doesn't match (object vs array vs number etc.), we return the fallback.
 * This makes "delete a setting to revert to default" trivial — just remove
 * the row.
 */
export async function getSetting<T>(key: SettingKey, fallback: T): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return coerce(cached.value, fallback);
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    return cacheAndReturn(key, fallback);
  }

  const { data, error } = await client
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error || !data || data.value == null) {
    return cacheAndReturn(key, fallback);
  }
  return cacheAndReturn(key, coerce(data.value, fallback));
}

/**
 * Coerce a raw JSONB value into the fallback's type. Numbers and strings
 * cross-coerce when possible; structurally-mismatched values return the
 * fallback to avoid blowing up callers.
 */
function coerce<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  // Number fallback expects a number — accept numeric strings.
  if (typeof fallback === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw as T;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n as T;
    }
    return fallback;
  }
  if (typeof fallback === "string") {
    if (typeof raw === "string") return raw as T;
    return fallback;
  }
  if (typeof fallback === "boolean") {
    if (typeof raw === "boolean") return raw as T;
    return fallback;
  }
  if (Array.isArray(fallback)) {
    if (Array.isArray(raw)) return raw as T;
    return fallback;
  }
  if (typeof fallback === "object" && fallback !== null) {
    if (typeof raw === "object" && !Array.isArray(raw)) return raw as T;
    return fallback;
  }
  return raw as T;
}

/**
 * Read all known settings in one round-trip — used by the admin Settings
 * page so a single render gets every editable knob.
 */
export async function listSettings(): Promise<SettingRow[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  const { data, error } = await client
    .from("system_settings")
    .select("key, value, description, updated_at, updated_by")
    .order("key", { ascending: true });
  if (error || !data) return [];
  return data
    .filter(
      (row): row is { key: string; value: unknown; description: string | null; updated_at: string; updated_by: string | null } =>
        row !== null && typeof row.key === "string",
    )
    .filter((row): row is { key: SettingKey; value: unknown; description: string | null; updated_at: string; updated_by: string | null } =>
      (row.key as SettingKey) in SETTING_KEYS,
    )
    .map((row) => ({
      key: row.key,
      value: row.value,
      description: row.description,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
}

/**
 * Write a setting. JSONB stores anything serialisable; per-key validation
 * lives at the API boundary (app/api/admin/settings/route.ts).
 */
export async function setSetting(
  key: SettingKey,
  value: unknown,
  updatedBy: string | null,
): Promise<unknown> {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("setSetting: Supabase not configured");
  }
  const { error } = await client
    .from("system_settings")
    .upsert(
      {
        key,
        value: value as unknown as object,
        updated_by: updatedBy,
      },
      { onConflict: "key" },
    );
  if (error) {
    throw new Error(`setSetting: ${error.message}`);
  }
  cache.delete(key);
  return value;
}

/**
 * Reset today's IP quota counters across all hashes. Used by the admin
 * "Reset today's quota" button. Unchanged from P1.11; lives here so
 * settings + reset are co-located.
 */
export async function resetTodayQuota(): Promise<number> {
  const client = getSupabaseAdminClient();
  if (!client) return 0;
  const { data, error } = await client.rpc("quota_reset_today");
  if (error) {
    throw new Error(`resetTodayQuota: ${error.message}`);
  }
  return typeof data === "number" ? data : 0;
}

function cacheAndReturn<T>(key: string, value: T): T {
  cache.set(key, { value, expiresAt: Date.now() + SETTINGS_TTL_MS });
  return value;
}

/** Test hook — wipes the in-memory cache so a test can simulate TTL roll. */
export function _resetSettingsCacheForTests(): void {
  cache.clear();
}
