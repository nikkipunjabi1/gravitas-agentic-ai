/**
 * Anthropic pricing — per-million-token rates.
 *
 * Single source of truth for cost-ledger math. Update here when Anthropic
 * adjusts pricing; the router reconciles real spend off these numbers.
 *
 * Values as of model release; cross-check at https://www.anthropic.com/pricing
 * before relying on these for billing-grade reporting.
 */

interface ModelPricing {
  /** $ per 1M input tokens. */
  inputPerM: number;
  /** $ per 1M output tokens. */
  outputPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.6 — current generation, primary voice-heavy + voice-light model.
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15 },
  // Haiku 4.5 — fallback when Ollama is unavailable.
  "claude-haiku-4-5-20251001": { inputPerM: 1, outputPerM: 5 },
};

/**
 * Cost of a single Anthropic call given known token counts.
 * Returns USD, rounded to 6 decimals (cost_ledger column precision).
 */
export function costOfCall(opts: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const rates = PRICING[opts.model];
  if (!rates) {
    // Unknown model — fail visibly so we update PRICING rather than under-bill.
    throw new Error(
      `pricing: no rates registered for model "${opts.model}". Update src/lib/models/pricing.ts.`,
    );
  }
  const cost =
    (opts.inputTokens / 1_000_000) * rates.inputPerM +
    (opts.outputTokens / 1_000_000) * rates.outputPerM;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Pre-flight cost estimate — used by the cost-ledger to decide whether a
 * call would breach the daily cap BEFORE the call is made.
 *
 * Estimates the worst case: full input tokens at input rate + full
 * `maxOutputTokens` at output rate. Reconciled to actuals after the call.
 */
export function estimateCallCost(opts: {
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
}): number {
  return costOfCall({
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.maxOutputTokens,
  });
}

/**
 * Cheap token-count proxy for pre-flight estimates. NOT a real tokenizer —
 * uses 4 chars ≈ 1 token (Anthropic's published rule of thumb).
 *
 * Real token counts come back on every Anthropic response via `usage.*` and
 * are what gets written to the ledger. This is only for the pre-flight call.
 */
export function estimateInputTokens(messages: { role: string; content: string }[]): number {
  const total = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(total / 4);
}

export const KNOWN_ANTHROPIC_MODELS = Object.keys(PRICING);
