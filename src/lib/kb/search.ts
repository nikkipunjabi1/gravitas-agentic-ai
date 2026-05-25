import "server-only";
import { embedOne } from "./embed";
import { getOrCreateCollection, query, type QueryHit } from "./client";

/**
 * Search the Gravitas KB for the top-k chunks relevant to a query.
 *
 * Returns at most `k` hits. Returns an empty array gracefully if Chroma is
 * unreachable or the collection is empty — the Discovery node treats an
 * empty result as "I don't have grounding for this question" and answers
 * honestly rather than fabricating.
 *
 * See docs/AGENTS.md → Discovery → "It never invents a case study, a
 * service name, or a metric — if the KB returns nothing relevant, Discovery
 * says so and pivots to a question."
 */

const COLLECTION_NAME =
  process.env.CHROMA_KB_COLLECTION ?? "gravitas-kb";

export interface KBChunk {
  id: string;
  text: string;
  url: string;
  title: string;
  section: string;
  /** Lower = more similar. Chroma returns L2 by default. */
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

  let collection;
  try {
    collection = await getOrCreateCollection(COLLECTION_NAME);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[kb] Chroma unreachable; returning empty hits:",
      (err as Error).message,
    );
    return [];
  }

  let hits: QueryHit[];
  try {
    hits = await query(collection.id, vec, k);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[kb] query failed; returning empty hits:", (err as Error).message);
    return [];
  }

  return hits.map((h) => ({
    id: h.id,
    text: h.document,
    url: typeof h.metadata.url === "string" ? h.metadata.url : "",
    title: typeof h.metadata.title === "string" ? h.metadata.title : "",
    section: typeof h.metadata.section === "string" ? h.metadata.section : "",
    distance: h.distance,
  }));
}
