import type { LoggedPurpose, Provider } from "./types";

/**
 * model_calls log sink.
 *
 * Per docs/ADMIN_PANEL.md, every Anthropic + Ollama call is written to a
 * `model_calls` row by the router — the single logging chokepoint. Phase 0
 * ships a console-log sink; Phase 1 swaps to a Supabase-backed sink.
 *
 * Do NOT call this directly from agent nodes or tools. If you find yourself
 * needing to, you're bypassing the chokepoint and that's a bug.
 */
export interface CallLog {
  record(row: ModelCallRow): Promise<void>;
}

export interface ModelCallRow {
  sessionId: string | null;
  node: string | null;
  provider: Provider;
  model: string;
  purpose: LoggedPurpose;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  latencyMs: number;
  wasBlocked: boolean;
  /** ISO 8601. Set by the router; the sink does not invent timestamps. */
  ts: string;
  /**
   * Provider-shape snapshot of the request handed in. Stored as JSONB so
   * the admin Flow page can render it on click. For Anthropic + Ollama:
   * `{ system, messages, options }`. May be null when capture is disabled
   * (e.g. in tests).
   */
  requestPayload?: unknown;
  /**
   * Provider-shape snapshot of the response. For Anthropic + Ollama:
   * `{ text, inputTokens, outputTokens }`. Streaming responses are
   * captured post-aggregation (final text). May be null on hard errors.
   */
  responsePayload?: unknown;
}

// ---------------------------------------------------------------------------
// Phase 0 sink — structured console.log on the server.
//
// Tagged with a `[model_calls]` prefix so it's grep-able. In production
// (Phase 1+) the Supabase sink replaces this; the console sink can still
// be enabled via env for local debugging.
// ---------------------------------------------------------------------------

export class ConsoleCallLog implements CallLog {
  async record(row: ModelCallRow): Promise<void> {
    // One line of JSON — easy to pipe into jq during dev.
    const line = JSON.stringify({ kind: "model_call", ...row });
    // eslint-disable-next-line no-console
    console.log(`[model_calls] ${line}`);
  }
}

/** No-op sink — used in tests when you don't want noise. */
export class NoopCallLog implements CallLog {
  async record(_row: ModelCallRow): Promise<void> {
    // intentionally empty
  }
}

export const defaultCallLog: CallLog = new ConsoleCallLog();
