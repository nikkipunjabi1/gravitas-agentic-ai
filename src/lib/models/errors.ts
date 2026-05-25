import type { Purpose } from "./types";

/**
 * Base class — every router error inherits from this. Agent nodes pattern-match
 * on the subclass; never on `.message`. Subclasses carry structured fields so
 * the cap-reached terminal node can build the DailyCapReached UIAction without
 * regexing strings.
 */
export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterError";
  }
}

/**
 * Raised when a `voice-heavy` call would breach the daily Anthropic cap.
 *
 * Caught by the LangGraph fallback edge → routes to the CapReached terminal
 * node, which emits a DailyCapReached UIAction. See docs/AGENTS.md → Edges,
 * and docs/ARCHITECTURE.md → Cost cap.
 *
 * `voice-light` calls NEVER throw this — they silently lite-mode-swap to
 * Ollama inside the router.
 */
export class DailyCapExceeded extends RouterError {
  override readonly name = "DailyCapExceeded";
  readonly purpose: Purpose;
  readonly estimatedCostUsd: number;
  readonly capUsd: number;

  constructor(opts: { purpose: Purpose; estimatedCostUsd: number; capUsd: number }) {
    super(
      `Daily Anthropic cap of $${opts.capUsd.toFixed(2)} would be exceeded by ` +
        `this ${opts.purpose} call (estimated $${opts.estimatedCostUsd.toFixed(4)}).`,
    );
    this.purpose = opts.purpose;
    this.estimatedCostUsd = opts.estimatedCostUsd;
    this.capUsd = opts.capUsd;
  }
}

/**
 * Raised when a provider is reachable but rejected the call (bad key, model
 * not found, content filter, 5xx). Agent nodes should treat as terminal for
 * the turn — no auto-retry inside the router; that's the agent's call.
 */
export class ProviderError extends RouterError {
  override readonly name = "ProviderError";
  readonly provider: "anthropic" | "ollama";
  readonly status: number | null;

  constructor(opts: {
    provider: "anthropic" | "ollama";
    status: number | null;
    message: string;
  }) {
    super(`[${opts.provider}] ${opts.message}`);
    this.provider = opts.provider;
    this.status = opts.status;
  }
}

/**
 * Raised when NO provider can serve the requested purpose:
 *   - Anthropic key missing AND Ollama unreachable
 *   - Cap is hit AND lite-mode target (Ollama) is also down
 *
 * This is the "site is fully dark" failure mode. Agent nodes catch and emit a
 * static fallback message. See docs/AGENTS.md → fallback chain.
 */
export class NoProviderAvailable extends RouterError {
  override readonly name = "NoProviderAvailable";
  readonly purpose: Purpose;
  readonly attempts: string[];

  constructor(opts: { purpose: Purpose; attempts: string[] }) {
    super(
      `No provider available for purpose "${opts.purpose}". ` +
        `Tried: ${opts.attempts.join(", ")}`,
    );
    this.purpose = opts.purpose;
    this.attempts = opts.attempts;
  }
}

/** Helper — narrow on `error instanceof RouterError` first, then on subclass. */
export function isRouterError(err: unknown): err is RouterError {
  return err instanceof RouterError;
}
