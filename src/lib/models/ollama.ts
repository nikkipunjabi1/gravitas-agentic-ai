import { ProviderError } from "./errors";
import type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  Message,
  StreamChunk,
  StreamResult,
} from "./types";

/**
 * Ollama provider — chat + embeddings via the local HTTP API.
 *
 * No SDK; the Ollama API is small enough that `fetch` is cleaner than a
 * third-party wrapper. We hit:
 *   - POST /api/chat        (streaming via NDJSON when stream=true)
 *   - POST /api/embeddings  (one input at a time — we loop)
 *   - GET  /api/tags        (health check)
 *
 * The router decides which model to use; the caller passes it in `model`.
 * Defaults read from env at the router layer, not here.
 *
 * Cost is always 0 — local + free. Latency and token counts ARE recorded
 * for symmetry with the Anthropic log rows.
 */

interface OllamaChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number; // max output tokens — Ollama's name for it
  };
}

interface OllamaChatResponse {
  model: string;
  message: { role: "assistant"; content: string };
  done: boolean;
  /** Only present on the final NDJSON chunk for stream=true, and always for stream=false. */
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaEmbedResponse {
  embedding: number[];
}

function getBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
}

async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network-level failure — Ollama not running, DNS, etc.
    throw new ProviderError({
      provider: "ollama",
      status: null,
      message: `unreachable at ${getBaseUrl()}: ${(err as Error).message}`,
    });
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new ProviderError({
      provider: "ollama",
      status: res.status,
      message: `${path} ${res.status}: ${text.slice(0, 200)}`,
    });
  }
  return (await res.json()) as T;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export interface OllamaCallOptions extends CompleteOptions {
  /** Which Ollama model to use (e.g. "deepseek-r1", "qwen3"). */
  model: string;
}

/** Non-streaming chat completion. */
export async function complete(
  opts: OllamaCallOptions,
): Promise<Omit<CompleteResult, "purpose">> {
  const start = Date.now();
  const body: OllamaChatRequest = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    options: {
      temperature: opts.temperature,
      num_predict: opts.maxTokens,
    },
  };
  const data = await postJson<OllamaChatResponse>("/api/chat", body, opts.signal);
  return {
    text: data.message.content,
    provider: "ollama",
    model: opts.model,
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    costUsd: 0,
    latencyMs: Date.now() - start,
  };
}

/** Streaming chat completion — NDJSON over HTTP. */
export async function stream(opts: OllamaCallOptions): Promise<StreamResult> {
  const start = Date.now();
  const url = `${getBaseUrl()}/api/chat`;
  const body: OllamaChatRequest = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    options: {
      temperature: opts.temperature,
      num_predict: opts.maxTokens,
    },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new ProviderError({
      provider: "ollama",
      status: null,
      message: `unreachable at ${getBaseUrl()}: ${(err as Error).message}`,
    });
  }
  if (!res.ok || !res.body) {
    const text = await safeText(res);
    throw new ProviderError({
      provider: "ollama",
      status: res.status,
      message: `/api/chat ${res.status}: ${text.slice(0, 200)}`,
    });
  }

  // Final-state closure for the `done` promise. Filled by the iterator when
  // the last NDJSON chunk arrives.
  let inputTokens = 0;
  let outputTokens = 0;
  let textBuf = "";
  let resolveDone!: (r: CompleteResult) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<CompleteResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";

  async function* iterate(): AsyncIterable<StreamChunk> {
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        const text = decoder.decode(value, { stream: true });
        leftover += text;
        const lines = leftover.split("\n");
        leftover = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          let chunk: OllamaChatResponse;
          try {
            chunk = JSON.parse(line) as OllamaChatResponse;
          } catch {
            // Skip malformed lines — Ollama very rarely emits these.
            continue;
          }
          if (chunk.message?.content) {
            textBuf += chunk.message.content;
            yield { textDelta: chunk.message.content };
          }
          if (chunk.done) {
            inputTokens = chunk.prompt_eval_count ?? inputTokens;
            outputTokens = chunk.eval_count ?? outputTokens;
          }
        }
      }
      resolveDone({
        text: textBuf,
        provider: "ollama",
        model: opts.model,
        purpose: "reasoning", // overwritten by the router based on the original purpose
        inputTokens,
        outputTokens,
        costUsd: 0,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      rejectDone(err);
      throw err;
    }
  }

  return { stream: iterate(), done };
}

/** Generate embeddings — one HTTP call per text (Ollama doesn't batch). */
export async function embed(opts: EmbedOptions & { model: string }): Promise<EmbedResult> {
  const start = Date.now();
  const vectors: number[][] = [];
  let inputTokens = 0;
  for (const text of opts.texts) {
    const data = await postJson<OllamaEmbedResponse>("/api/embeddings", {
      model: opts.model,
      prompt: text,
    });
    vectors.push(data.embedding);
    inputTokens += Math.ceil(text.length / 4); // rough — Ollama doesn't report
  }
  return {
    vectors,
    provider: "ollama",
    model: opts.model,
    inputTokens,
    costUsd: 0,
    latencyMs: Date.now() - start,
  };
}

/**
 * Health check — returns true if Ollama responds at /api/tags.
 *
 * Cached for 60s. A chat turn can fire multiple Ollama-bound calls (embed
 * for KB, classify for intent in Phase 2); without caching we'd re-pay the
 * 1.5s connect timeout each time when Ollama isn't running. The cache flips
 * on the FIRST probe per minute and is invalidated by `forceFresh`.
 *
 * The admin Health page passes `forceFresh: true` so an admin who just
 * started `ollama serve` doesn't have to wait 60s for the dot to update.
 */
const REACHABILITY_TTL_MS = 60_000;
let cachedReachability: { ok: boolean; ts: number } | null = null;

export async function isReachable(opts?: {
  timeoutMs?: number;
  forceFresh?: boolean;
}): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 1500;
  if (!opts?.forceFresh && cachedReachability) {
    if (Date.now() - cachedReachability.ts < REACHABILITY_TTL_MS) {
      return cachedReachability.ok;
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ok = false;
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: controller.signal });
    ok = res.ok;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  cachedReachability = { ok, ts: Date.now() };
  return ok;
}

/** Flatten any leading system messages into a single string. Used when a
 *  caller wants to talk to a provider that accepts system separately. */
export function flattenSystem(messages: Message[]): {
  system: string;
  rest: Message[];
} {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: systems.join("\n\n"), rest };
}
