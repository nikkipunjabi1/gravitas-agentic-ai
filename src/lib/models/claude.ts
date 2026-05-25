import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./errors";
import { costOfCall } from "./pricing";
import type {
  CompleteOptions,
  CompleteResult,
  Message,
  StreamChunk,
  StreamResult,
} from "./types";

/**
 * Anthropic (Claude) provider.
 *
 * Wraps the official SDK. Only the router imports this — agent nodes go
 * through `router.complete()` / `router.stream()` so the cap and the log
 * row are always honoured. CLAUDE.md guardrail: "No raw
 * anthropic.messages.create calls anywhere else in the code."
 *
 * The router passes the model name explicitly; defaults live there.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderError({
      provider: "anthropic",
      status: null,
      message: "ANTHROPIC_API_KEY is not set",
    });
  }
  client = new Anthropic({ apiKey });
  return client;
}

export interface ClaudeCallOptions extends CompleteOptions {
  /** Anthropic model id, e.g. "claude-sonnet-4-6". */
  model: string;
}

function splitSystem(messages: Message[]): {
  system: string | undefined;
  conv: { role: "user" | "assistant"; content: string }[];
} {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  const conv = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return {
    system: systems.length > 0 ? systems.join("\n\n") : undefined,
    conv,
  };
}

function extractText(content: Anthropic.ContentBlock[]): string {
  // We only request text responses; structured-output usage will add a tool-use
  // branch later. Concatenate every text block to be safe.
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Non-streaming completion. */
export async function complete(
  opts: ClaudeCallOptions,
): Promise<Omit<CompleteResult, "purpose">> {
  const start = Date.now();
  const { system, conv } = splitSystem(opts.messages);
  let response: Anthropic.Message;
  try {
    response = await getClient().messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature,
        system,
        messages: conv,
      },
      { signal: opts.signal },
    );
  } catch (err) {
    throw wrapAnthropicError(err);
  }
  const text = extractText(response.content);
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    text,
    provider: "anthropic",
    model: opts.model,
    inputTokens,
    outputTokens,
    costUsd: costOfCall({ model: opts.model, inputTokens, outputTokens }),
    latencyMs: Date.now() - start,
  };
}

/** Streaming completion — yields text deltas, resolves `done` with totals. */
export async function stream(opts: ClaudeCallOptions): Promise<StreamResult> {
  const start = Date.now();
  const { system, conv } = splitSystem(opts.messages);

  let messageStream: ReturnType<Anthropic["messages"]["stream"]>;
  try {
    messageStream = getClient().messages.stream(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature,
        system,
        messages: conv,
      },
      { signal: opts.signal },
    );
  } catch (err) {
    throw wrapAnthropicError(err);
  }

  let resolveDone!: (r: CompleteResult) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<CompleteResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  async function* iterate(): AsyncIterable<StreamChunk> {
    try {
      for await (const event of messageStream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { textDelta: event.delta.text };
        }
      }
      const final = await messageStream.finalMessage();
      const inputTokens = final.usage.input_tokens;
      const outputTokens = final.usage.output_tokens;
      resolveDone({
        text: extractText(final.content),
        provider: "anthropic",
        model: opts.model,
        purpose: "voice-light", // overwritten by the router
        inputTokens,
        outputTokens,
        costUsd: costOfCall({ model: opts.model, inputTokens, outputTokens }),
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      const wrapped = wrapAnthropicError(err);
      rejectDone(wrapped);
      throw wrapped;
    }
  }

  return { stream: iterate(), done };
}

/**
 * Health check — Phase 0 implementation.
 *
 * SDK 0.32 doesn't expose a free reachability endpoint (no `client.models.list`
 * yet). Doing a `messages.create` with max_tokens=1 would work but costs ~$0
 * per check and would muddy the ledger. For Phase 0 we treat "key present" as
 * "reachable"; the router never calls this anyway (only `/admin/health` and
 * the Phase-1 graph need a true round-trip check, and they can do their own
 * tiny `messages.create` then).
 */
export async function isReachable(_timeoutMs = 2000): Promise<boolean> {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function wrapAnthropicError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    return new ProviderError({
      provider: "anthropic",
      status: err.status ?? null,
      message: err.message,
    });
  }
  if (err instanceof Error) {
    return new ProviderError({
      provider: "anthropic",
      status: null,
      message: err.message,
    });
  }
  return new ProviderError({
    provider: "anthropic",
    status: null,
    message: "unknown anthropic error",
  });
}
