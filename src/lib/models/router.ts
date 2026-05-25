import * as anthropic from "./claude";
import * as ollama from "./ollama";
import { DailyCapExceeded, NoProviderAvailable, RouterError } from "./errors";
import { defaultCostLedger, type CostLedger } from "./cost-ledger";
import { defaultCallLog, type CallLog } from "./call-log";
import { estimateCallCost, estimateInputTokens } from "./pricing";
import type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  LoggedPurpose,
  Provider,
  Purpose,
  StreamChunk,
  StreamResult,
} from "./types";

/**
 * ModelRouter — the single chokepoint for every Anthropic + Ollama call.
 *
 * CLAUDE.md guardrails this enforces:
 *   - "Bypass the daily cost cap" → every Anthropic call goes through here.
 *   - "Mis-tier a purpose" → callers pass `purpose`, the router decides
 *     which provider + which cap rule applies.
 *   - "Bypass the logging chokepoint" → every successful + blocked call
 *     produces a model_calls row via the call-log.
 *
 * Lite-mode + cap behaviour summary (docs/ARCHITECTURE.md → Cost cap):
 *
 *   voice-light + cap hit  → silent swap to Ollama Qwen3 (lite mode)
 *   voice-heavy + cap hit  → throw DailyCapExceeded
 *   reasoning / classify / intent / embed  → Ollama only
 *   Ollama down for non-voice → fall back to Anthropic Haiku (NEVER Sonnet)
 *   voice-light + no Anthropic key → swap to Ollama, but DON'T count
 *     against `lite_mode_substitutions` (that metric is cap-driven only)
 *   voice-heavy + no Anthropic key + Ollama up → throw NoProviderAvailable
 *     (heavy voice REQUIRES Sonnet — Haiku is not a substitute)
 *
 * The class wraps two injected dependencies (CostLedger + CallLog) so tests
 * and Phase 1's Supabase swap don't require touching this file.
 */
export class ModelRouter {
  constructor(
    private readonly ledger: CostLedger = defaultCostLedger,
    private readonly log: CallLog = defaultCallLog,
  ) {}

  // -------------------------------------------------------------------------
  // Public API — agent nodes call these
  // -------------------------------------------------------------------------

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const decision = await this.decide(opts.purpose, opts);

    if (decision.kind === "block") {
      // voice-heavy refused. Log the blocked attempt, then throw.
      await this.recordBlocked(decision, opts);
      throw decision.error;
    }

    // Pre-flight: tell the ledger we're about to spend (Anthropic only).
    if (decision.provider === "anthropic") {
      await this.ledger.recordEstimate(decision.estimatedCostUsd);
    }
    if (decision.kind === "lite-swap-cap") {
      await this.ledger.recordLiteSwap();
    }

    let result: Omit<CompleteResult, "purpose">;
    try {
      result = await this.callComplete(decision.provider, decision.model, opts);
    } catch (err) {
      // Provider failed mid-call. We still recorded the estimate; reconcile
      // by subtracting it so the ledger doesn't drift up.
      if (decision.provider === "anthropic") {
        await this.ledger.recordActual(0, decision.estimatedCostUsd);
      }
      throw err;
    }

    if (decision.provider === "anthropic") {
      await this.ledger.recordActual(result.costUsd, decision.estimatedCostUsd);
    }

    const loggedPurpose: LoggedPurpose =
      decision.kind === "lite-swap-cap" || decision.kind === "lite-swap-nokey"
        ? "voice-light-degraded"
        : opts.purpose;

    await this.log.record({
      sessionId: opts.sessionId ?? null,
      node: opts.node ?? null,
      provider: result.provider,
      model: result.model,
      purpose: loggedPurpose,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      wasBlocked: false,
      ts: new Date().toISOString(),
    });

    return { ...result, purpose: loggedPurpose };
  }

  async stream(opts: CompleteOptions): Promise<StreamResult> {
    const decision = await this.decide(opts.purpose, opts);

    if (decision.kind === "block") {
      await this.recordBlocked(decision, opts);
      throw decision.error;
    }

    if (decision.provider === "anthropic") {
      await this.ledger.recordEstimate(decision.estimatedCostUsd);
    }
    if (decision.kind === "lite-swap-cap") {
      await this.ledger.recordLiteSwap();
    }

    const loggedPurpose: LoggedPurpose =
      decision.kind === "lite-swap-cap" || decision.kind === "lite-swap-nokey"
        ? "voice-light-degraded"
        : opts.purpose;

    const inner = await this.callStream(decision.provider, decision.model, opts);

    // Wrap `done` so we can reconcile the ledger + write the model_calls row
    // when the upstream stream finalises, without leaking that to the caller.
    const done: Promise<CompleteResult> = inner.done
      .then(async (raw) => {
        if (decision.provider === "anthropic") {
          await this.ledger.recordActual(raw.costUsd, decision.estimatedCostUsd);
        }
        const final: CompleteResult = { ...raw, purpose: loggedPurpose };
        await this.log.record({
          sessionId: opts.sessionId ?? null,
          node: opts.node ?? null,
          provider: final.provider,
          model: final.model,
          purpose: loggedPurpose,
          inputTokens: final.inputTokens,
          outputTokens: final.outputTokens,
          costUsd: final.costUsd,
          latencyMs: final.latencyMs,
          wasBlocked: false,
          ts: new Date().toISOString(),
        });
        return final;
      })
      .catch(async (err) => {
        if (decision.provider === "anthropic") {
          await this.ledger.recordActual(0, decision.estimatedCostUsd);
        }
        throw err;
      });

    return { stream: inner.stream, done };
  }

  async embed(opts: EmbedOptions): Promise<EmbedResult> {
    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const reachable = await ollama.isReachable();
    if (!reachable) {
      throw new NoProviderAvailable({
        purpose: "embed",
        attempts: ["ollama (unreachable)"],
      });
    }
    const result = await ollama.embed({ ...opts, model });
    await this.log.record({
      sessionId: opts.sessionId ?? null,
      node: opts.node ?? null,
      provider: "ollama",
      model,
      purpose: "embed",
      inputTokens: result.inputTokens,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: result.latencyMs,
      wasBlocked: false,
      ts: new Date().toISOString(),
    });
    return result;
  }

  /** Snapshot of today's ledger — used by /admin and tests. */
  async ledgerSnapshot() {
    return this.ledger.snapshot();
  }

  // -------------------------------------------------------------------------
  // Internal — decide, dispatch, log helpers
  // -------------------------------------------------------------------------

  /**
   * Decide which provider + model serves this call, and whether the cap
   * or a missing key forces a swap or a block. PURE — no provider call yet.
   */
  private async decide(
    purpose: Purpose,
    opts: CompleteOptions,
  ): Promise<RouteDecision> {
    const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const sonnet = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    const haiku = process.env.ANTHROPIC_FALLBACK_MODEL ?? "claude-haiku-4-5-20251001";
    const reasoningModel = process.env.OLLAMA_REASONING_MODEL ?? "deepseek-r1";
    const fastModel = process.env.OLLAMA_FAST_MODEL ?? "qwen3";

    if (purpose === "voice-heavy") {
      if (!hasAnthropicKey) {
        // Heavy voice requires Sonnet; Haiku isn't designed for this role.
        return {
          kind: "block",
          error: new NoProviderAvailable({
            purpose,
            attempts: ["anthropic (no key)"],
          }),
          provider: "anthropic",
          model: sonnet,
          estimatedCostUsd: 0,
        };
      }
      const estimate = estimateCallCost({
        model: sonnet,
        inputTokens: estimateInputTokens(opts.messages),
        maxOutputTokens: opts.maxTokens ?? 2048,
      });
      if (await this.ledger.wouldExceed(estimate)) {
        const snap = await this.ledger.snapshot();
        return {
          kind: "block",
          error: new DailyCapExceeded({
            purpose,
            estimatedCostUsd: estimate,
            capUsd: snap.capUsd,
          }),
          provider: "anthropic",
          model: sonnet,
          estimatedCostUsd: estimate,
        };
      }
      return {
        kind: "normal",
        provider: "anthropic",
        model: sonnet,
        estimatedCostUsd: estimate,
      };
    }

    if (purpose === "voice-light") {
      if (!hasAnthropicKey) {
        // Degrade silently to Ollama — but don't count as cap-driven lite-swap.
        return {
          kind: "lite-swap-nokey",
          provider: "ollama",
          model: fastModel,
          estimatedCostUsd: 0,
        };
      }
      const estimate = estimateCallCost({
        model: sonnet,
        inputTokens: estimateInputTokens(opts.messages),
        maxOutputTokens: opts.maxTokens ?? 512,
      });
      if (await this.ledger.wouldExceed(estimate)) {
        return {
          kind: "lite-swap-cap",
          provider: "ollama",
          model: fastModel,
          estimatedCostUsd: 0,
        };
      }
      return {
        kind: "normal",
        provider: "anthropic",
        model: sonnet,
        estimatedCostUsd: estimate,
      };
    }

    // Non-voice purposes — Ollama-first, with Haiku as the failure fallback.
    const ollamaModel = purpose === "reasoning" ? reasoningModel : fastModel;
    const ollamaUp = await ollama.isReachable();
    if (ollamaUp) {
      return {
        kind: "normal",
        provider: "ollama",
        model: ollamaModel,
        estimatedCostUsd: 0,
      };
    }
    // Ollama down → fall back to Haiku (NEVER Sonnet).
    if (hasAnthropicKey) {
      const estimate = estimateCallCost({
        model: haiku,
        inputTokens: estimateInputTokens(opts.messages),
        maxOutputTokens: opts.maxTokens ?? 512,
      });
      // Even fallback respects the cap — heavy reasoning sessions shouldn't
      // accidentally drain the cap when Ollama is down.
      if (await this.ledger.wouldExceed(estimate)) {
        const snap = await this.ledger.snapshot();
        return {
          kind: "block",
          error: new DailyCapExceeded({
            purpose,
            estimatedCostUsd: estimate,
            capUsd: snap.capUsd,
          }),
          provider: "anthropic",
          model: haiku,
          estimatedCostUsd: estimate,
        };
      }
      return {
        kind: "normal",
        provider: "anthropic",
        model: haiku,
        estimatedCostUsd: estimate,
      };
    }
    return {
      kind: "block",
      error: new NoProviderAvailable({
        purpose,
        attempts: ["ollama (unreachable)", "anthropic (no key)"],
      }),
      provider: "ollama",
      model: ollamaModel,
      estimatedCostUsd: 0,
    };
  }

  private async callComplete(
    provider: Provider,
    model: string,
    opts: CompleteOptions,
  ): Promise<Omit<CompleteResult, "purpose">> {
    if (provider === "anthropic") {
      return anthropic.complete({ ...opts, model });
    }
    return ollama.complete({ ...opts, model });
  }

  private async callStream(
    provider: Provider,
    model: string,
    opts: CompleteOptions,
  ): Promise<StreamResult> {
    if (provider === "anthropic") {
      return anthropic.stream({ ...opts, model });
    }
    return ollama.stream({ ...opts, model });
  }

  private async recordBlocked(
    decision: BlockDecision,
    opts: CompleteOptions,
  ): Promise<void> {
    await this.ledger.recordBlocked(opts.purpose);
    await this.log.record({
      sessionId: opts.sessionId ?? null,
      node: opts.node ?? null,
      provider: decision.provider,
      model: decision.model,
      purpose: opts.purpose,
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
      latencyMs: 0,
      wasBlocked: true,
      ts: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Internal decision-types
// ---------------------------------------------------------------------------

type RouteDecision = NormalDecision | LiteSwapDecision | BlockDecision;

interface NormalDecision {
  kind: "normal";
  provider: Provider;
  model: string;
  estimatedCostUsd: number;
}

interface LiteSwapDecision {
  kind: "lite-swap-cap" | "lite-swap-nokey";
  provider: "ollama";
  model: string;
  estimatedCostUsd: 0;
}

interface BlockDecision {
  kind: "block";
  error: RouterError;
  provider: Provider;
  model: string;
  estimatedCostUsd: number;
}

// ---------------------------------------------------------------------------
// Module-singleton — agent nodes import this. Tests can construct their own.
// ---------------------------------------------------------------------------

export const router: ModelRouter = new ModelRouter();

// Re-export the chunk type for stream consumers.
export type { StreamChunk };
