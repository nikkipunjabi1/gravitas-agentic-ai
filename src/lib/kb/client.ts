/**
 * Tiny ChromaDB v2 REST client.
 *
 * Why not the official chromadb SDK:
 *   - One more npm dep (~200KB), with version-detection logic that breaks
 *     across Chroma server versions.
 *   - We need a tight subset: create collection, upsert, query. ~80 lines
 *     of fetch() is cheaper than threading SDK quirks through every layer.
 *
 * Server-side only — depends on `process.env.CHROMA_URL`. Lightweight client
 * for the agent app; the worker has its own copy in worker/src/kb-ingest.ts
 * (separate workspace, different runtime, can't share an import).
 *
 * Phase 2 backlog: hoist this to a shared @gravitas/contracts workspace.
 *
 * Reference: Chroma v2 API — https://docs.trychroma.com/reference/js-client
 */

import "server-only";

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_TENANT = "default_tenant";
const DEFAULT_DATABASE = "default_database";

export interface ChromaConfig {
  baseUrl?: string;
  tenant?: string;
  database?: string;
  timeoutMs?: number;
}

function cfg(opts?: ChromaConfig) {
  return {
    baseUrl: opts?.baseUrl ?? process.env.CHROMA_URL ?? DEFAULT_BASE_URL,
    tenant: opts?.tenant ?? process.env.CHROMA_TENANT ?? DEFAULT_TENANT,
    database: opts?.database ?? process.env.CHROMA_DATABASE ?? DEFAULT_DATABASE,
    timeoutMs: opts?.timeoutMs ?? 5000,
  };
}

export class ChromaError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "ChromaError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  opts?: ChromaConfig,
): Promise<T> {
  const { baseUrl, timeoutMs } = cfg(opts);
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new ChromaError(
        `${init.method ?? "GET"} ${path} ${res.status}: ${text.slice(0, 240)}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ChromaError) throw err;
    throw new ChromaError(
      `request to ${url} failed: ${(err as Error).message}`,
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Public API — narrow surface, exactly what the agent + worker ingest need.
// ---------------------------------------------------------------------------

export interface Collection {
  id: string;
  name: string;
}

/** Health check — returns true if Chroma responds within the timeout. */
export async function isReachable(opts?: ChromaConfig): Promise<boolean> {
  try {
    await request<unknown>("/api/v2/heartbeat", { method: "GET" }, { ...opts, timeoutMs: opts?.timeoutMs ?? 1500 });
    return true;
  } catch {
    return false;
  }
}

/** Get or create a collection by name. Idempotent. */
export async function getOrCreateCollection(
  name: string,
  opts?: ChromaConfig,
): Promise<Collection> {
  const { tenant, database } = cfg(opts);
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections`;
  const body = {
    name,
    get_or_create: true,
    metadata: { source: "gravitas-copilot" },
  };
  const data = await request<{ id: string; name: string }>(
    path,
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
  return { id: data.id, name: data.name };
}

export interface UpsertItem {
  id: string;
  embedding: number[];
  document: string;
  metadata: Record<string, string | number | boolean | null>;
}

/** Upsert a batch of vectors. Caller chunks if size grows large. */
export async function upsert(
  collectionId: string,
  items: UpsertItem[],
  opts?: ChromaConfig,
): Promise<void> {
  if (items.length === 0) return;
  const { tenant, database } = cfg(opts);
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${collectionId}/upsert`;
  await request<unknown>(
    path,
    {
      method: "POST",
      body: JSON.stringify({
        ids: items.map((i) => i.id),
        embeddings: items.map((i) => i.embedding),
        documents: items.map((i) => i.document),
        metadatas: items.map((i) => i.metadata),
      }),
    },
    opts,
  );
}

export interface QueryHit {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

/**
 * Vector search — returns top-k nearest neighbours. Caller supplies the
 * embedding (we don't embed here so the same vector dimension is used by
 * the agent at query time and the worker at ingest time).
 */
export async function query(
  collectionId: string,
  embedding: number[],
  k: number,
  opts?: ChromaConfig,
): Promise<QueryHit[]> {
  const { tenant, database } = cfg(opts);
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${collectionId}/query`;
  const data = await request<{
    ids: string[][];
    distances: number[][];
    documents: string[][];
    metadatas: Record<string, unknown>[][];
  }>(
    path,
    {
      method: "POST",
      body: JSON.stringify({
        query_embeddings: [embedding],
        n_results: k,
      }),
    },
    opts,
  );
  const ids = data.ids[0] ?? [];
  const docs = data.documents[0] ?? [];
  const dists = data.distances[0] ?? [];
  const metas = data.metadatas[0] ?? [];
  const hits: QueryHit[] = [];
  for (let i = 0; i < ids.length; i++) {
    hits.push({
      id: ids[i] ?? "",
      document: docs[i] ?? "",
      distance: dists[i] ?? Number.POSITIVE_INFINITY,
      metadata: metas[i] ?? {},
    });
  }
  return hits;
}

/** Delete documents by id. Used when a KB page is removed from the sitemap. */
export async function deleteDocs(
  collectionId: string,
  ids: string[],
  opts?: ChromaConfig,
): Promise<void> {
  if (ids.length === 0) return;
  const { tenant, database } = cfg(opts);
  const path = `/api/v2/tenants/${encodeURIComponent(tenant)}/databases/${encodeURIComponent(database)}/collections/${collectionId}/delete`;
  await request<unknown>(
    path,
    {
      method: "POST",
      body: JSON.stringify({ ids }),
    },
    opts,
  );
}
