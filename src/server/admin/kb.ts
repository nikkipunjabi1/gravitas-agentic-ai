import "server-only";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * Admin queries + mutations for the KB control surface (/admin/kb).
 *
 * Reads:  current cadence + sitemap URL from admin_settings; latest run row;
 *         last N runs.
 * Writes: update cadence; we do NOT write run rows here — the worker owns
 *         that table while a run is in flight.
 */

export interface KbSettings {
  cadenceHours: number | null;
  sitemapUrl: string;
}

export const CADENCE_OPTIONS: { label: string; hours: number | null }[] = [
  { label: "Every 24 hours", hours: 24 },
  { label: "Every 7 days", hours: 168 },
  { label: "Every 30 days", hours: 720 },
  { label: "Manual only", hours: null },
];

export async function getKbSettings(): Promise<KbSettings> {
  const client = getSupabaseAdminClient();
  const sitemapDefault =
    process.env.GRAVITAS_SITEMAP_URL ?? "https://thisisgravitas.com/sitemap.xml";
  if (!client) {
    return { cadenceHours: 24, sitemapUrl: sitemapDefault };
  }
  const { data, error } = await client
    .from("admin_settings")
    .select("kb_refresh_cadence_hours, gravitas_sitemap_url")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) {
    return { cadenceHours: 24, sitemapUrl: sitemapDefault };
  }
  const row = data as { kb_refresh_cadence_hours: number | null; gravitas_sitemap_url: string | null };
  return {
    cadenceHours: row.kb_refresh_cadence_hours,
    sitemapUrl: row.gravitas_sitemap_url ?? sitemapDefault,
  };
}

export async function setKbCadence(hours: number | null): Promise<void> {
  const client = getSupabaseAdminClient();
  if (!client) return;
  const { error } = await client
    .from("admin_settings")
    .update({ kb_refresh_cadence_hours: hours })
    .eq("id", 1);
  if (error) throw new Error(`setKbCadence failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Notifications (Phase 1.8) — admin_settings.kb_notify_*
// ---------------------------------------------------------------------------

export interface KbNotificationSettings {
  emails: string[];
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

export async function getKbNotificationSettings(): Promise<KbNotificationSettings> {
  const client = getSupabaseAdminClient();
  if (!client) {
    return { emails: [], notifyOnSuccess: true, notifyOnFailure: true };
  }
  const { data, error } = await client
    .from("admin_settings")
    .select("kb_notify_emails, kb_notify_on_success, kb_notify_on_failure")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) {
    return { emails: [], notifyOnSuccess: true, notifyOnFailure: true };
  }
  const row = data as {
    kb_notify_emails: string[] | null;
    kb_notify_on_success: boolean | null;
    kb_notify_on_failure: boolean | null;
  };
  return {
    emails: (row.kb_notify_emails ?? []).filter((e) => typeof e === "string" && e.length > 0),
    notifyOnSuccess: row.kb_notify_on_success !== false,
    notifyOnFailure: row.kb_notify_on_failure !== false,
  };
}

export async function setKbNotificationSettings(
  patch: Partial<KbNotificationSettings>,
): Promise<void> {
  const client = getSupabaseAdminClient();
  if (!client) return;
  const update: Record<string, unknown> = {};
  if (patch.emails !== undefined) {
    // De-dupe + normalise. Empty array is valid (= disable notifications).
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of patch.emails) {
      const e = String(raw).trim().toLowerCase();
      if (e.length === 0) continue;
      if (seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    update.kb_notify_emails = cleaned;
  }
  if (patch.notifyOnSuccess !== undefined) update.kb_notify_on_success = patch.notifyOnSuccess;
  if (patch.notifyOnFailure !== undefined) update.kb_notify_on_failure = patch.notifyOnFailure;
  if (Object.keys(update).length === 0) return;
  const { error } = await client
    .from("admin_settings")
    .update(update)
    .eq("id", 1);
  if (error) throw new Error(`setKbNotificationSettings failed: ${error.message}`);
}

export interface KbRun {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "failed";
  mode: "incremental" | "reseed";
  triggeredBy: string;
  pagesPlanned: number;
  pagesFetched: number;
  pagesUnchanged: number;
  pagesErrored: number;
  chunksEmbedded: number;
  errorMessage: string | null;
}

function rowToRun(r: {
  id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  mode: string;
  triggered_by: string;
  pages_planned: number;
  pages_fetched: number;
  pages_unchanged: number;
  pages_errored: number;
  chunks_embedded: number;
  error_message: string | null;
}): KbRun {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: (r.status as KbRun["status"]) ?? "completed",
    mode: (r.mode as KbRun["mode"]) ?? "incremental",
    triggeredBy: r.triggered_by,
    pagesPlanned: r.pages_planned,
    pagesFetched: r.pages_fetched,
    pagesUnchanged: r.pages_unchanged,
    pagesErrored: r.pages_errored,
    chunksEmbedded: r.chunks_embedded,
    errorMessage: r.error_message,
  };
}

export async function listKbRuns(limit = 20): Promise<KbRun[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  const { data, error } = await client
    .from("kb_ingest_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Parameters<typeof rowToRun>[0][]).map(rowToRun);
}

export async function getCurrentRun(): Promise<KbRun | null> {
  const client = getSupabaseAdminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("kb_ingest_runs")
    .select("*")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return rowToRun(data as Parameters<typeof rowToRun>[0]);
}

export async function getLastCompletedRun(): Promise<KbRun | null> {
  const client = getSupabaseAdminClient();
  if (!client) return null;
  const { data, error } = await client
    .from("kb_ingest_runs")
    .select("*")
    .eq("status", "completed")
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return rowToRun(data as Parameters<typeof rowToRun>[0]);
}

// ---------------------------------------------------------------------------
// kb_documents — the per-URL manifest of what's in the KB
// ---------------------------------------------------------------------------

export interface KbDocument {
  url: string;
  lastModified: string | null;
  contentHash: string | null;
  chunkCount: number;
  indexedAt: string | null;
  status: string;
  errorMessage: string | null;
}

export async function listKbDocuments(limit = 100): Promise<KbDocument[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  const { data, error } = await client
    .from("kb_documents")
    .select("url, last_modified, content_hash, chunk_count, indexed_at, status, error_message")
    .order("indexed_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Array<{
    url: string;
    last_modified: string | null;
    content_hash: string | null;
    chunk_count: number;
    indexed_at: string | null;
    status: string;
    error_message: string | null;
  }>).map((r) => ({
    url: r.url,
    lastModified: r.last_modified,
    contentHash: r.content_hash,
    chunkCount: r.chunk_count,
    indexedAt: r.indexed_at,
    status: r.status,
    errorMessage: r.error_message,
  }));
}

/**
 * Compute the next due time given cadence + last completed run. Returns null
 * if cadence is "manual only" (null) — UI then shows "manual only".
 */
export function computeNextDue(
  cadenceHours: number | null,
  lastCompletedAt: string | null,
): Date | null {
  if (cadenceHours === null) return null;
  const last = lastCompletedAt ? new Date(lastCompletedAt) : new Date(0);
  return new Date(last.getTime() + cadenceHours * 60 * 60 * 1000);
}
