// env-loader MUST come first — `pnpm kb:reseed` invokes this file directly,
// not via the Fastify entrypoint, so it can't rely on index.ts having
// already loaded .env.local. Importing it twice is safe (idempotent).
import "./env-loader.js";

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import * as cheerio from "cheerio";
import { z } from "zod";
import { sendIngestNotification, type KbRunSummary } from "./email.js";

/**
 * KB ingest pipeline — Phase 1.
 *
 * Two modes:
 *   --reseed:  full crawl of the whitelist regardless of lastmod.
 *   default:   incremental — sitemap diff against `kb_documents`, re-embed
 *              only changed pages.
 *
 * Pipeline (per URL):
 *   1. fetch HTML (cheerio's lightweight HTTP — no Playwright; KB pages are
 *      static enough that JS rendering is overkill and would be 50x slower)
 *   2. extract title, sectioned content blocks
 *   3. chunk content (max ~1200 chars per chunk, overlap-free at section
 *      boundaries)
 *   4. embed each chunk via Ollama
 *   5. upsert to Chroma collection
 *   6. update kb_documents row (url, hash, lastmod, indexed_at)
 *
 * Storage:
 *   - Chroma: chunked content + embeddings + metadata
 *   - Supabase kb_documents: one row per URL, used as the diff source
 *
 * Endpoints / CLI:
 *   - HTTP: POST /kb/refresh (registered in worker/src/index.ts) — daily cron
 *   - CLI:  `pnpm kb:reseed` — runs main() with --reseed
 *
 * See docs/ARCHITECTURE.md → Gravitas knowledge base.
 */

// We crawl EVERYTHING in the sitemap by default and reject only obvious
// noise via KB_EXCLUDE_RX below. The previous allowlist was too restrictive
// — Gravitas's site structure has top-level pages like
// /experience-design-strategy and /capability-enablement that don't sit
// under /services, so the allowlist silently dropped roughly a third of
// the sitemap (35 entries in, ~20 ingested).
//
// If you ever need to tighten this up (e.g. to skip a specific path family),
// add the pattern to KB_EXCLUDE_RX rather than re-introducing the allowlist.
const KB_EXCLUDE_RX =
  /(privacy|cookie|policy|terms|legal|search|tag|paginate|sitemap|feed|rss|atom)(\/|$|\?)/i;

const CHUNK_TARGET_CHARS = 1200;
const MAX_CHUNK_CHARS = 1600;
const REQUEST_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 3;

const SitemapEntry = z.object({
  loc: z.string().url(),
  lastmod: z.string().optional(),
});
type SitemapEntry = z.infer<typeof SitemapEntry>;

interface IngestStats {
  pagesConsidered: number;
  pagesFetched: number;
  pagesUnchanged: number;
  pagesEmbedded: number;
  pagesErrored: number;
  chunksEmbedded: number;
  durationMs: number;
}

export interface IngestOptions {
  reseed?: boolean;
  /** Override the canonical sitemap URL — handy for testing. */
  sitemapUrl?: string;
  /** Who triggered this run. Recorded in kb_ingest_runs.triggered_by. */
  triggeredBy?: string;
  /** Inject test logger; defaults to console. */
  log?: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function runIngest(opts: IngestOptions = {}): Promise<IngestStats> {
  const startedAt = Date.now();
  const log = opts.log ?? defaultLogger();
  const sitemapUrl = opts.sitemapUrl ?? process.env.GRAVITAS_SITEMAP_URL ?? "https://thisisgravitas.com/sitemap.xml";
  const supabase = getSupabase();
  const mode = opts.reseed ? "reseed" : "incremental";
  const triggeredBy = opts.triggeredBy ?? "cli";

  // Record the run start in kb_ingest_runs so /admin/kb can show in-flight
  // progress. The id we get back is updated as the run progresses.
  const runId = await startRunRow(supabase, { mode, triggeredBy });
  log.info(`[kb-ingest] starting ${mode} run`, { sitemapUrl, runId });

  // 1. Pull sitemap
  let entries: SitemapEntry[];
  try {
    entries = await fetchSitemap(sitemapUrl);
  } catch (err) {
    log.error("[kb-ingest] sitemap fetch failed", { err: (err as Error).message });
    await finishRunRow(supabase, runId, {
      status: "failed",
      errorMessage: `sitemap fetch failed: ${(err as Error).message}`,
    });
    throw err;
  }

  // 2. Filter by whitelist
  const whitelisted = entries.filter(entryAllowed);
  log.info(`[kb-ingest] sitemap has ${entries.length} entries; ${whitelisted.length} whitelisted`);

  // 3. Diff against kb_documents (skip in reseed mode)
  const existingManifest = supabase ? await loadManifest(supabase) : new Map<string, ManifestRow>();
  const todo = opts.reseed
    ? whitelisted
    : whitelisted.filter((e) => needsRefresh(e, existingManifest.get(e.loc)));
  log.info(`[kb-ingest] ${todo.length} pages to (re-)embed`);

  await updateRunRow(supabase, runId, { pagesPlanned: todo.length });

  // 4. Fetch + extract + embed + upsert, with bounded concurrency
  const stats: IngestStats = {
    pagesConsidered: whitelisted.length,
    pagesFetched: 0,
    pagesUnchanged: whitelisted.length - todo.length,
    pagesEmbedded: 0,
    pagesErrored: 0,
    chunksEmbedded: 0,
    durationMs: 0,
  };

  try {
    const collectionId = await ensureCollection();
    await runConcurrent(todo, FETCH_CONCURRENCY, async (entry) => {
      try {
        const result = await processOne(entry, collectionId, supabase, log);
        stats.pagesFetched += 1;
        stats.pagesEmbedded += result.chunkCount > 0 ? 1 : 0;
        stats.chunksEmbedded += result.chunkCount;
        // Best-effort progress write — never block per-page work on the
        // progress row. Failures here just leave the admin UI a tick stale.
        await updateRunRow(supabase, runId, {
          pagesFetched: stats.pagesFetched,
          chunksEmbedded: stats.chunksEmbedded,
        });
      } catch (err) {
        stats.pagesErrored += 1;
        log.warn("[kb-ingest] page failed", {
          url: entry.loc,
          err: (err as Error).message,
        });
        if (supabase) {
          await markDocError(supabase, entry.loc, (err as Error).message).catch(() => undefined);
        }
        await updateRunRow(supabase, runId, { pagesErrored: stats.pagesErrored });
      }
    });

    stats.durationMs = Date.now() - startedAt;
    const finalStatus: "completed" | "failed" =
      stats.pagesErrored > 0 && stats.pagesFetched === 0 ? "failed" : "completed";
    await finishRunRow(supabase, runId, {
      status: finalStatus,
      pagesFetched: stats.pagesFetched,
      pagesUnchanged: stats.pagesUnchanged,
      pagesErrored: stats.pagesErrored,
      chunksEmbedded: stats.chunksEmbedded,
    });
    log.info(`[kb-ingest] complete`, stats);
    // Best-effort notification — never blocks or fails the run.
    await sendIngestNotification(
      supabase,
      buildSummary(runId, finalStatus, mode, triggeredBy, stats, null, todo.length),
      log,
    );
    return stats;
  } catch (err) {
    stats.durationMs = Date.now() - startedAt;
    const errorMessage = (err as Error).message;
    await finishRunRow(supabase, runId, {
      status: "failed",
      errorMessage,
      pagesFetched: stats.pagesFetched,
      pagesErrored: stats.pagesErrored,
      chunksEmbedded: stats.chunksEmbedded,
    });
    await sendIngestNotification(
      supabase,
      buildSummary(runId, "failed", mode, triggeredBy, stats, errorMessage, 0),
      log,
    );
    throw err;
  }
}

/**
 * Pack the in-flight stats into the shape the email module expects.
 */
function buildSummary(
  runId: string | null,
  status: "completed" | "failed",
  mode: "incremental" | "reseed",
  triggeredBy: string,
  stats: IngestStats,
  errorMessage: string | null,
  pagesPlanned: number,
): KbRunSummary {
  return {
    runId,
    status,
    mode,
    triggeredBy,
    pagesPlanned,
    pagesFetched: stats.pagesFetched,
    pagesUnchanged: stats.pagesUnchanged,
    pagesErrored: stats.pagesErrored,
    chunksEmbedded: stats.chunksEmbedded,
    durationMs: stats.durationMs,
    errorMessage,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  };
}

// ---------------------------------------------------------------------------
// kb_ingest_runs row helpers — defensive: every call swallows DB errors so a
// transient Supabase blip doesn't break the actual ingest.
// ---------------------------------------------------------------------------

async function startRunRow(
  supabase: SupabaseClient | null,
  opts: { mode: string; triggeredBy: string },
): Promise<string | null> {
  if (!supabase) return null;
  const id = crypto.randomUUID();
  const { error } = await supabase.from("kb_ingest_runs").insert({
    id,
    status: "running",
    mode: opts.mode,
    triggered_by: opts.triggeredBy,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[kb-ingest] could not record run start:", error.message);
    return null;
  }
  return id;
}

interface RunRowUpdate {
  status?: "running" | "completed" | "failed";
  pagesPlanned?: number;
  pagesFetched?: number;
  pagesUnchanged?: number;
  pagesErrored?: number;
  chunksEmbedded?: number;
  errorMessage?: string | null;
}

async function updateRunRow(
  supabase: SupabaseClient | null,
  runId: string | null,
  patch: RunRowUpdate,
): Promise<void> {
  if (!supabase || !runId) return;
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.pagesPlanned !== undefined) update.pages_planned = patch.pagesPlanned;
  if (patch.pagesFetched !== undefined) update.pages_fetched = patch.pagesFetched;
  if (patch.pagesUnchanged !== undefined) update.pages_unchanged = patch.pagesUnchanged;
  if (patch.pagesErrored !== undefined) update.pages_errored = patch.pagesErrored;
  if (patch.chunksEmbedded !== undefined) update.chunks_embedded = patch.chunksEmbedded;
  if (patch.errorMessage !== undefined) update.error_message = patch.errorMessage;
  if (Object.keys(update).length === 0) return;
  const { error } = await supabase.from("kb_ingest_runs").update(update).eq("id", runId);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[kb-ingest] could not update run row:", error.message);
  }
}

async function finishRunRow(
  supabase: SupabaseClient | null,
  runId: string | null,
  patch: RunRowUpdate,
): Promise<void> {
  if (!supabase || !runId) return;
  await updateRunRow(supabase, runId, patch);
  const { error } = await supabase
    .from("kb_ingest_runs")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[kb-ingest] could not stamp ended_at:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

async function fetchSitemap(url: string): Promise<SitemapEntry[]> {
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  if (!res.ok) throw new Error(`sitemap GET ${res.status}`);
  const xml = await res.text();
  return parseSitemap(xml);
}

/**
 * Tiny sitemap parser — accepts urlset OR sitemapindex (recursively fetches
 * inner sitemaps up to one level deep — Gravitas is small).
 */
async function parseSitemap(xml: string): Promise<SitemapEntry[]> {
  const $ = cheerio.load(xml, { xmlMode: true });
  const inner: SitemapEntry[] = [];
  $("url").each((_, el) => {
    const $el = $(el);
    const loc = $el.find("loc").first().text().trim();
    const lastmod = $el.find("lastmod").first().text().trim() || undefined;
    if (loc) inner.push({ loc, lastmod });
  });
  if (inner.length > 0) return inner;
  // sitemapindex — recurse
  const indexes: string[] = [];
  $("sitemap").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    if (loc) indexes.push(loc);
  });
  const all: SitemapEntry[] = [];
  for (const idx of indexes) {
    try {
      const res = await fetchWithTimeout(idx, REQUEST_TIMEOUT_MS);
      if (!res.ok) continue;
      all.push(...(await parseSitemap(await res.text())));
    } catch {
      // skip
    }
  }
  return all;
}

function entryAllowed(entry: SitemapEntry): boolean {
  let parsed: URL;
  try {
    parsed = new URL(entry.loc);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  // Deny-list only — privacy/legal/admin/feed paths get filtered. Everything
  // else in the sitemap (service pages, case studies, insights, contact,
  // careers, flagship offerings like /firstmakers) is fair KB content.
  return !KB_EXCLUDE_RX.test(path);
}

// ---------------------------------------------------------------------------
// Per-page processing
// ---------------------------------------------------------------------------

interface ManifestRow {
  url: string;
  last_modified: string | null;
  content_hash: string | null;
  chunk_count: number;
  indexed_at: string | null;
  status: string;
}

function needsRefresh(entry: SitemapEntry, row: ManifestRow | undefined): boolean {
  if (!row) return true;
  if (row.status !== "indexed") return true;
  if (entry.lastmod && row.last_modified && entry.lastmod > row.last_modified) return true;
  return false;
}

interface ProcessResult {
  chunkCount: number;
  contentHash: string;
}

async function processOne(
  entry: SitemapEntry,
  collectionId: string,
  supabase: SupabaseClient | null,
  log: IngestOptions["log"] & object,
): Promise<ProcessResult> {
  // 1. Fetch
  const html = await fetchHtml(entry.loc);
  const contentHash = hashContent(html);

  // 2. Short-circuit: if hash matches manifest, skip embedding (but still
  // update last_modified). This catches lastmod-bumped-but-content-unchanged.
  if (supabase) {
    const { data } = await supabase
      .from("kb_documents")
      .select("content_hash")
      .eq("url", entry.loc)
      .maybeSingle();
    if (data?.content_hash === contentHash) {
      await supabase
        .from("kb_documents")
        .update({
          last_modified: entry.lastmod ?? null,
          indexed_at: new Date().toISOString(),
          status: "indexed",
        })
        .eq("url", entry.loc);
      return { chunkCount: 0, contentHash };
    }
  }

  // 3. Extract content blocks
  const blocks = extractBlocks(html);
  if (blocks.length === 0) {
    log.warn("[kb-ingest] no content blocks extracted; skipping", { url: entry.loc });
    return { chunkCount: 0, contentHash };
  }

  // 4. Chunk
  const chunks = chunkBlocks(blocks);
  if (chunks.length === 0) {
    return { chunkCount: 0, contentHash };
  }

  // 5. Embed (batched) — one request per chunk into Ollama
  const embeddings = await embedAll(chunks.map((c) => c.text));

  // 6. Upsert into Chroma. Stable ids = hash of url + chunkIndex so reseed
  //    doesn't accumulate orphans.
  const title = extractTitle(html) ?? entry.loc;
  const items = chunks.map((c, i) => ({
    id: stableChunkId(entry.loc, i),
    embedding: embeddings[i] as number[],
    document: c.text,
    metadata: {
      url: entry.loc,
      title,
      section: c.section ?? "",
      chunkIndex: i,
      contentHash,
    },
  }));
  await chromaUpsert(collectionId, items);

  // 7. Update manifest
  if (supabase) {
    await supabase.from("kb_documents").upsert({
      url: entry.loc,
      last_modified: entry.lastmod ?? null,
      content_hash: contentHash,
      chunk_count: chunks.length,
      indexed_at: new Date().toISOString(),
      status: "indexed",
      error_message: null,
    });
  }

  return { chunkCount: chunks.length, contentHash };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; GravitasCoPilotIngest/1.0; +https://thisisgravitas.com)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  return await res.text();
}

function hashContent(html: string): string {
  return createHash("sha256").update(html).digest("hex");
}

function extractTitle(html: string): string | null {
  const $ = cheerio.load(html);
  const t = $("title").first().text().trim();
  return t.length > 0 ? t : null;
}

interface ContentBlock {
  section: string | null;
  text: string;
}

/**
 * Extract reading-order content blocks: each block is a paragraph (or heading
 * + paragraph) under the most recent heading. Strips nav/footer/asides which
 * are template chrome on most marketing sites.
 */
function extractBlocks(html: string): ContentBlock[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, nav, footer, aside, header form").remove();

  const blocks: ContentBlock[] = [];
  let currentSection: string | null = null;

  // Walk body in document order, picking up headings + paragraph-ish text.
  const main = $("main").first().length > 0 ? $("main").first() : $("body").first();
  main
    .find("h1, h2, h3, h4, p, li, blockquote, figcaption")
    .each((_, el) => {
      const $el = $(el);
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
      const text = $el.text().replace(/\s+/g, " ").trim();
      if (text.length === 0) return;
      if (tag.startsWith("h")) {
        currentSection = text;
      }
      blocks.push({ section: currentSection, text });
    });

  return blocks;
}

interface Chunk {
  section: string | null;
  text: string;
}

/**
 * Greedy block-packing chunker. Concatenate blocks until the running text
 * passes CHUNK_TARGET_CHARS, then emit. Never split a single block across
 * chunks. Cap at MAX_CHUNK_CHARS — a single oversize block becomes its own
 * (oversize) chunk; we don't sub-split paragraphs in Phase 1.
 */
function chunkBlocks(blocks: ContentBlock[]): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let bufSection: string | null = null;

  for (const block of blocks) {
    const candidateLen = bufLen + (bufLen === 0 ? 0 : 1) + block.text.length;
    if (bufLen > 0 && candidateLen > CHUNK_TARGET_CHARS) {
      chunks.push({ section: bufSection, text: buf.join("\n") });
      buf = [];
      bufLen = 0;
      bufSection = null;
    }
    if (bufLen === 0) bufSection = block.section;
    buf.push(block.text);
    bufLen += block.text.length + 1;
    if (bufLen >= MAX_CHUNK_CHARS) {
      chunks.push({ section: bufSection, text: buf.join("\n") });
      buf = [];
      bufLen = 0;
      bufSection = null;
    }
  }
  if (buf.length > 0) {
    chunks.push({ section: bufSection, text: buf.join("\n") });
  }
  return chunks;
}

function stableChunkId(url: string, index: number): string {
  return createHash("sha1").update(`${url}#${index}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Embeddings — call Ollama directly. Worker doesn't share the agent app's
// model router; the router lives in Next.js code and is not importable here.
// Ollama base URL comes from env.
// ---------------------------------------------------------------------------

async function embedAll(texts: string[]): Promise<number[][]> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const out: number[][] = [];
  for (const text of texts) {
    const res = await fetchWithTimeout(
      `${base}/api/embeddings`,
      REQUEST_TIMEOUT_MS,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      },
    );
    if (!res.ok) {
      throw new Error(`Ollama embed → HTTP ${res.status}`);
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding) throw new Error("Ollama embed returned no `embedding`");
    out.push(data.embedding);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chroma — small v2 REST helpers, mirrored from the agent app's lib/kb/client.
// They live here too because workspaces don't share src/ imports.
// ---------------------------------------------------------------------------

async function ensureCollection(): Promise<string> {
  const base = process.env.CHROMA_URL ?? "http://localhost:8000";
  const tenant = process.env.CHROMA_TENANT ?? "default_tenant";
  const database = process.env.CHROMA_DATABASE ?? "default_database";
  const name = process.env.CHROMA_KB_COLLECTION ?? "gravitas-kb";
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections`;
  const res = await fetchWithTimeout(`${base}${path}`, REQUEST_TIMEOUT_MS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      get_or_create: true,
      metadata: { source: "gravitas-copilot" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chroma get_or_create → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function chromaUpsert(
  collectionId: string,
  items: {
    id: string;
    embedding: number[];
    document: string;
    metadata: Record<string, string | number | boolean | null>;
  }[],
): Promise<void> {
  if (items.length === 0) return;
  const base = process.env.CHROMA_URL ?? "http://localhost:8000";
  const tenant = process.env.CHROMA_TENANT ?? "default_tenant";
  const database = process.env.CHROMA_DATABASE ?? "default_database";
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${collectionId}/upsert`;
  const res = await fetchWithTimeout(`${base}${path}`, REQUEST_TIMEOUT_MS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids: items.map((i) => i.id),
      embeddings: items.map((i) => i.embedding),
      documents: items.map((i) => i.document),
      metadatas: items.map((i) => i.metadata),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`chroma upsert → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Supabase manifest
// ---------------------------------------------------------------------------

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: "public" },
    // Node 18 has no native WebSocket; @supabase/realtime-js fails at
    // construction time even when we never use realtime. Pass `ws` as the
    // transport to satisfy the constructor. Harmless on Node 22+ (no-op).
    realtime: {
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  });
}

async function loadManifest(supabase: SupabaseClient): Promise<Map<string, ManifestRow>> {
  const { data, error } = await supabase
    .from("kb_documents")
    .select("url, last_modified, content_hash, chunk_count, indexed_at, status");
  if (error) {
    throw new Error(`load manifest: ${error.message}`);
  }
  const map = new Map<string, ManifestRow>();
  for (const row of (data ?? []) as ManifestRow[]) {
    map.set(row.url, row);
  }
  return map;
}

async function markDocError(
  supabase: SupabaseClient,
  url: string,
  message: string,
): Promise<void> {
  await supabase.from("kb_documents").upsert({
    url,
    status: "error",
    error_message: message.slice(0, 1000),
    indexed_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (!item) continue;
      try {
        await worker(item);
      } catch {
        // worker is responsible for its own error logging
      }
      // Be polite — small inter-request delay reduces hammering origin.
      await sleep(50);
    }
  });
  await Promise.all(workers);
}

function defaultLogger() {
  /* eslint-disable no-console */
  return {
    info: (msg: string, meta?: unknown) =>
      console.log(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
    warn: (msg: string, meta?: unknown) =>
      console.warn(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
    error: (msg: string, meta?: unknown) =>
      console.error(meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`),
  };
  /* eslint-enable no-console */
}

// ---------------------------------------------------------------------------
// CLI entry — invoked by `pnpm kb:reseed`
// ---------------------------------------------------------------------------

const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv.some((a) => a.endsWith("kb-ingest.ts") || a.endsWith("kb-ingest.js"));

if (isCli) {
  const reseed = process.argv.includes("--reseed");
  void runIngest({ reseed })
    .then((stats) => {
      /* eslint-disable-next-line no-console */
      console.log(`[kb-ingest] done`, stats);
      process.exit(stats.pagesErrored > 0 ? 1 : 0);
    })
    .catch((err) => {
      /* eslint-disable-next-line no-console */
      console.error("[kb-ingest] FATAL", err);
      process.exit(2);
    });
}
