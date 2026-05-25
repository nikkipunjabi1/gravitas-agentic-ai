/**
 * Public types for the model router.
 *
 * Agent nodes import these (and `router` itself) — never a provider
 * directly. See docs/AGENTS.md → Model routing rules.
 */

/**
 * Every router call carries a `purpose`. Purposes are tiered:
 *
 *   light  — voice-light: 2–4 sentence user-facing turns (Discovery KB
 *            answer, Output closing). Typical cost <$0.005.
 *   heavy  — voice-heavy: Audit narration, Strategy synthesis, Executive
 *            Brief composition. Typical cost $0.10–$1.00.
 *   ollama — reasoning / classify / intent / embed. Free, local. Never
 *            counts toward the daily cap.
 *
 * Mis-tagging is a bug — CLAUDE.md guardrail "Mis-tier a purpose".
 */
export type Purpose =
  | "voice-light"
  | "voice-heavy"
  | "reasoning"
  | "classify"
  | "intent"
  | "embed";

/**
 * `voice-light-degraded` is set by the router when the daily cap is hit
 * and a `voice-light` call was silently swapped to Ollama. Agent nodes
 * NEVER pass this in; it only ever appears on the result + the log row.
 */
export type LoggedPurpose = Purpose | "voice-light-degraded";

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export type Provider = "anthropic" | "ollama";

export interface CompleteOptions {
  /** Tier — drives provider selection AND cap behaviour. */
  purpose: Purpose;
  /** Conversation so far. System messages are flattened to a system prompt
   *  for providers that take it separately (Anthropic). */
  messages: Message[];
  /** Override the cap on output tokens. Provider-specific defaults apply. */
  maxTokens?: number;
  /** 0–1. Defaults are purpose-aware (voice uses lower, reasoning higher). */
  temperature?: number;
  /** Optional session id — flows into the model_calls log row. */
  sessionId?: string;
  /** Which agent node initiated the call — flows into the log row. */
  node?: string;
  /** Optional abort signal — Phase 1 streams hook this up to client disconnects. */
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  provider: Provider;
  model: string;
  /** What was logged. Same as `opts.purpose` unless lite-mode kicked in. */
  purpose: LoggedPurpose;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface StreamChunk {
  /** Plain text delta — the chat pane consumes these. */
  textDelta: string;
}

export interface StreamResult {
  /** Async iterable of incremental text chunks. */
  stream: AsyncIterable<StreamChunk>;
  /** Resolves to the finalised CompleteResult after the stream closes.
   *  Used by the router to write the model_calls row with real token counts. */
  done: Promise<CompleteResult>;
}

export interface EmbedOptions {
  texts: string[];
  sessionId?: string;
  node?: string;
}

export interface EmbedResult {
  /** One vector per input text. */
  vectors: number[][];
  provider: Provider;
  model: string;
  inputTokens: number;
  latencyMs: number;
  /** Always 0 for Ollama embeddings — kept for log-row symmetry. */
  costUsd: number;
}
