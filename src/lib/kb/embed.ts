import "server-only";
import { getServerRouter } from "@/server/model-router";

/**
 * Embed a batch of texts via the model router.
 *
 * Always goes through the router (and therefore through the call-log
 * chokepoint) so embeddings show up in `/admin` like any other model call.
 * The router routes `purpose: "embed"` to Ollama nomic-embed-text by
 * default (see docs/AGENTS.md → routing rules).
 *
 * Returns vectors in the same order as input. Dimensionality depends on the
 * embedding model (nomic-embed-text = 768).
 */
export async function embedTexts(opts: {
  texts: string[];
  sessionId?: string;
  node?: string;
}): Promise<number[][]> {
  if (opts.texts.length === 0) return [];
  const result = await getServerRouter().embed({
    texts: opts.texts,
    sessionId: opts.sessionId,
    node: opts.node,
  });
  return result.vectors;
}

/** Convenience: embed a single text, return the single vector. */
export async function embedOne(opts: {
  text: string;
  sessionId?: string;
  node?: string;
}): Promise<number[]> {
  const [vec] = await embedTexts({
    texts: [opts.text],
    sessionId: opts.sessionId,
    node: opts.node,
  });
  if (!vec) {
    throw new Error("embed returned no vectors");
  }
  return vec;
}
