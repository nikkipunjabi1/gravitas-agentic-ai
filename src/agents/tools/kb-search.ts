import "server-only";
import { searchKB, type KBChunk } from "@/lib/kb";

/**
 * kb-search agent tool — top-k Gravitas KB chunks for a query.
 *
 * Thin re-export of `searchKB` to keep agent code reading from a tools/
 * surface instead of reaching into lib/. Same graceful-degradation behaviour:
 * returns `[]` if Chroma is down or the KB is empty.
 *
 * See docs/AGENTS.md → Tool inventory.
 */

export interface KbSearchInput {
  query: string;
  k?: number;
  sessionId?: string;
  node?: string;
}

export async function kbSearch(input: KbSearchInput): Promise<KBChunk[]> {
  return searchKB(input);
}
