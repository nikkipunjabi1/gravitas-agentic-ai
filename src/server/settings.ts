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
 *                                rate-limit caps, cost-cap thresholds (P2),
 *                                content moderation knobs (P2).
 *
 * Reads are cached app-side for SETTINGS_TTL_MS so we don't hammer Postgres
 * on every chat turn. Writes invalidate the cache process-locally; other
 * Next.js instances pick up the change within ~TTL.
 *
 * Fallback: when Supabase isn't configured (dev clones with no env vars),
 * every read returns the seeded default below. The app stays functional.
 */

const SETTINGS_TTL_MS = 60_000;

interface CachedValue<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CachedValue<unknown>>();

/**
 * Built-in defaults — used both for the dev fallback (no Supabase) and as
 * the typed seed in src/lib/quota/ip-quota.ts. Keep this aligned with the
 * INSERT statement in supabase/migrations/0005_system_settings.sql.
 */
export const SETTING_DEFAULTS = {
  ip_daily_turn_limit: 20,
  ip_daily_audit_limit: 3,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export interface SettingRow {
  key: SettingKey;
  value: number;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Read a single setting. Returns the cached value when available; falls
 * back to the seeded default when Supabase isn't configured OR the row is
 * absent. Always resolves — never throws — so quota checks never block
 * on a transient Postgres outage.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
): Promise<number> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as number;
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    return cacheAndReturn(key, SETTING_DEFAULTS[key]);
  }

  const { data, error } = await client
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) {
    return cacheAndReturn(key, SETTING_DEFAULTS[key]);
  }
  const raw = data.value;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    return cacheAndReturn(key, SETTING_DEFAULTS[key]);
  }
  return cacheAndReturn(key, parsed);
}

/**
 * Read all known settings in one round-trip — used by the admin Settings
 * page so a single render gets every editable knob with its description +
 * audit metadata.
 */
export async function listSettings(): Promise<SettingRow[]> {
  const client = getSupabaseAdminClient();
  if (!client) {
    return Object.entries(SETTING_DEFAULTS).map(([k, v]) => ({
      key: k as SettingKey,
      value: v,
      description: null,
      updatedAt: new Date(0).toISOString(),
      updatedBy: null,
    }));
  }
  const { data, error } = await client
    .from("system_settings")
    .select("key, value, description, updated_at, updated_by")
    .order("key", { ascending: true });
  if (error || !data) {
    return [];
  }
  return data
    .filter(
      (row): row is { key: string; value: unknown; description: string | null; updated_at: string; updated_by: string | null } =>
        row !== null && typeof row.key === "string",
    )
    .filter((row): row is { key: SettingKey; value: unknown; description: string | null; updated_at: string; updated_by: string | null } =>
      (row.key as SettingKey) in SETTING_DEFAULTS,
    )
    .map((row) => {
      const raw = row.value;
      const parsed = typeof raw === "number" ? raw : Number(raw);
      return {
        key: row.key,
        value: Number.isFinite(parsed) ? parsed : SETTING_DEFAULTS[row.key],
        description: row.description,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    });
}

/**
 * Write a setting. Validates the value against a per-key allowed range
 * before persisting — admins shouldn't be able to set the audit limit to
 * 9999 by accident. Returns the new value (so callers can echo it back).
 *
 * Cache is invalidated for this key on the current process. Other
 * processes pick it up within SETTINGS_TTL_MS.
 */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: number,
  updatedBy: string | null,
): Promise<number> {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`setSetting: ${key} requires a non-negative integer`);
  }
  const max = SETTING_MAXIMUMS[key];
  if (value > max) {
    throw new Error(`setSetting: ${key} exceeds maximum allowed value (${max})`);
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("setSetting: Supabase not configured");
  }

  const { error } = await client
    .from("system_settings")
    .upsert(
      {
        key,
        value: value as unknown as object, // stored as jsonb
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
 * Hard caps so an admin typo can't accidentally turn the cap to 1 million.
 * Numbers picked to be "obviously too high for a cap" — they exist as guard
 * rails, not as targets.
 */
const SETTING_MAXIMUMS: Record<SettingKey, number> = {
  ip_daily_turn_limit: 1000,
  ip_daily_audit_limit: 100,
};

/**
 * Reset today's IP quota counters across all hashes. Used by the admin
 * "Reset today's quota" button — useful for demos that hit the cap. Returns
 * the number of rows that were deleted (admins like seeing a confirmation
 * number).
 *
 * Implemented as a Postgres function so it can run in one round-trip even
 * if the table has millions of rows.
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

function cacheAndReturn(key: string, value: number): number {
  cache.set(key, { value, expiresAt: Date.now() + SETTINGS_TTL_MS });
  return value;
}

/** Test hook — wipes the in-memory cache so a test can simulate TTL roll. */
export function _resetSettingsCacheForTests(): void {
  cache.clear();
}
