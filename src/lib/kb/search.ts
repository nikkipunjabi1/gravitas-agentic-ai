import "server-only";
import { embedOne } from "./embed";
import { searchChunks } from "./pgvector";

/**
 * Search the Gravitas KB for the top-k chunks relevant to a query.
 *
 * Backed by Supabase pgvector (P1.17). Returns at most `k` hits OR an
 * empty array when Supabase is unreachable / the table is empty — the
 * Discovery node treats an empty result as "I don't have grounding for
 * this question" and answers honestly rather than fabricating.
 *
 * See docs/AGENTS.md → Discovery → "It never invents a case study, a
 * service name, or a metric — if the KB returns nothing relevant,
 * Discovery says so and pivots to a question."
 */

export interface KBChunk {
  id: string;
  text: string;
  url: string;
  title: string;
  section: string;
  /** Lower = more similar. pgvector cosine distance. */
  distance: number;
}

export async function searchKB(opts: {
  query: string;
  k?: number;
  sessionId?: string;
  node?: string;
}): Promise<KBChunk[]> {
  const k = opts.k ?? 4;

  let vec: number[];
  try {
    vec = await embedOne({
      text: opts.query,
      sessionId: opts.sessionId,
      node: opts.node,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[kb] embed failed; returning empty hits:", (err as Error).message);
    return [];
  }

  const hits = await searchChunks(vec, k);

  return hits.map((h) => ({
    id: h.id,
    text: h.content,
    url:
      typeof h.metadata.url === "string"
        ? h.metadata.url
        : h.documentUrl,
    title: typeof h.metadata.title === "string" ? h.metadata.title : "",
    section: typeof h.metadata.section === "string" ? h.metadata.section : "",
    distance: h.distance,
  }));
}
