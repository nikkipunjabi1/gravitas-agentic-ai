import { getWorkerSupabase } from "./supabase.js";

/**
 * Worker-side settings reader.
 *
 * Mirrors the Next.js side's getSetting() but stripped down — the worker
 * only consumes a handful of keys (KB sitemap URL + whitelist, currently).
 * Cached for 60s like the Next.js side.
 *
 * If Supabase is unreachable OR the row is missing, returns the caller-
 * supplied fallback. Worker ingest must keep running even if the admin
 * panel database is having a bad day.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getWorkerSetting<T>(key: string, fallback: T): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return coerce(cached.value, fallback);
  }
  const supabase = getWorkerSupabase();
  if (!supabase) {
    return cacheAndReturn(key, fallback);
  }
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error || !data || data.value == null) {
    return cacheAndReturn(key, fallback);
  }
  return cacheAndReturn(key, coerce(data.value, fallback));
}

function coerce<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof fallback === "string") {
    return typeof raw === "string" ? (raw as T) : fallback;
  }
  if (typeof fallback === "number") {
    if (typeof raw === "number") return raw as T;
    if (typeof raw === "string") {
      const n = Number(raw);
      return Number.isFinite(n) ? (n as T) : fallback;
    }
    return fallback;
  }
  if (Array.isArray(fallback)) {
    return Array.isArray(raw) ? (raw as T) : fallback;
  }
  return raw as T;
}

function cacheAndReturn<T>(key: string, value: T): T {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
