import "server-only";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * Supabase pgvector client — replaces ChromaDB as of P1.17.
 *
 * The agent reads (knn search) via `searchChunks`. The worker writes
 * (upsert) via a sibling module under worker/src/pgvector.ts.
 *
 * Why pgvector over Chroma:
 *   - One fewer service to run (Docker container gone).
 *   - Admins can browse chunks in Supabase Studio + /admin/kb.
 *   - Bespoke client deployments get vector storage for free with the
 *     Supabase project they already have.
 *
 * Embedding dimension: 768 (Ollama nomic-embed-text). Column type is
 * fixed in migration 0007_pgvector_kb.sql; if you swap to a different
 * embedding model with a different dimension, alter the table + reseed.
 */

export interface ChunkHit {
  id: string;
  documentUrl: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance — smaller = more similar. */
  distance: number;
}

/**
 * kNN search over kb_chunks using a pre-computed embedding. Empty array
 * is returned gracefully when Supabase isn't configured OR the table is
 * empty — agent treats empty as "no grounding, answer honestly."
 */
export async function searchChunks(
  embedding: number[],
  k = 4,
): Promise<ChunkHit[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  // pgvector accepts a string-literal vector in PostgREST RPC body. The
  // PostgREST + pgvector marshalling is lenient — the array marshalls as
  // a JSON array which Postgres casts to vector(768) via the RPC signature.
  const { data, error } = await client.rpc("kb_chunks_search", {
    p_embedding: embedding,
    p_limit: k,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.warn("[kb-pgvector] search failed:", error.message);
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter(
      (r): r is {
        id: string;
        document_url: string;
        content: string;
        metadata: Record<string, unknown> | null;
        distance: number;
      } => r != null && typeof r.id === "string",
    )
    .map((r) => ({
      id: r.id,
      documentUrl: r.document_url,
      content: r.content,
      metadata: r.metadata ?? {},
      distance: typeof r.distance === "number" ? r.distance : Number(r.distance),
    }));
}

/**
 * List chunks for a single document. Used by the admin chunks viewer
 * — paginate via offset/limit; for the typical doc that's 1–10 chunks
 * the limit rarely bites.
 */
export interface DocumentChunk {
  id: string;
  documentUrl: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  hasEmbedding: boolean;
}

export async function listChunksForDocument(
  documentUrl: string,
  limit = 50,
): Promise<DocumentChunk[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  // Select everything BUT the embedding column — those 768 floats are a
  // few KB each and the admin doesn't need to see them. The chunk content
  // + metadata + audit timestamps are the useful bits.
  const { data, error } = await client
    .from("kb_chunks")
    .select("id, document_url, content, metadata, created_at, updated_at, embedding")
    .eq("document_url", documentUrl)
    .order("id", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    document_url: string;
    content: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
    embedding: unknown;
  }>).map((r) => ({
    id: r.id,
    documentUrl: r.document_url,
    content: r.content,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasEmbedding: r.embedding != null,
  }));
}

/** Total chunk count across the KB — used by the admin overview. */
export async function countChunks(): Promise<number> {
  const client = getSupabaseAdminClient();
  if (!client) return 0;
  const { count, error } = await client
    .from("kb_chunks")
    .select("id", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}
