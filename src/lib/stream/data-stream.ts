/**
 * Minimal writer for the Vercel AI SDK Data Stream Protocol v1.
 *
 * Why a hand-rolled writer instead of `ai`'s DataStreamWriter:
 *   - Decouples our chat endpoint from internal SDK helper types that have
 *     shifted across `ai` major versions. The wire format is stable; the
 *     internal type names are not.
 *   - Keeps the streaming surface tiny: text + data + finish + error. That's
 *     all the chat+canvas split needs. (UI_CONTRACT.md → Wire protocol.)
 *
 * Protocol reference: https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
 *
 * Line format:  TYPE_ID:JSON\n
 *   0  text part           — JSON string of the text delta
 *   2  data part           — JSON array (writeData wraps the value in [ ])
 *   3  error part          — JSON string of the error message
 *   d  finish message part — {"finishReason":"stop","usage":{...}}
 *
 * Client side: `useChat({ api })` parses this protocol. `messages` is built
 * from text parts; `data` is the flattened concatenation of every data
 * part's array contents.
 */

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONValue[]
  | { [k: string]: JSONValue };

export interface DataStreamWriter {
  /** Emit a text delta — appears in the chat message stream. */
  writeText(text: string): void;
  /** Emit a typed data part — appears in `useChat().data`. */
  writeData(value: JSONValue): void;
  /** Emit a finish message. Idempotent. */
  finish(opts?: { finishReason?: FinishReason; usage?: Usage }): void;
  /** Emit an error part. Closes the stream. */
  error(err: unknown): void;
  /** Close the underlying readable stream. */
  close(): void;
}

export type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

const DEFAULT_HEADERS: HeadersInit = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Vercel-AI-Data-Stream": "v1",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

/** Convenience: returns the headers a Response should carry alongside a data stream. */
export function dataStreamHeaders(): HeadersInit {
  return { ...DEFAULT_HEADERS };
}

/**
 * Create a paired (ReadableStream, DataStreamWriter). Caller starts an async
 * task that pushes to the writer and returns the stream as a Response body.
 *
 *   const { stream, writer } = createDataStream();
 *   (async () => { try { ... writer.writeText("hi") ... } finally { writer.close() } })();
 *   return new Response(stream, { headers: dataStreamHeaders() });
 */
export function createDataStream(): {
  stream: ReadableStream<Uint8Array>;
  writer: DataStreamWriter;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  function send(line: string): void {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(line));
    } catch {
      closed = true;
    }
  }

  const writer: DataStreamWriter = {
    writeText(text) {
      if (!text) return;
      send(`0:${JSON.stringify(text)}\n`);
    },
    writeData(value) {
      // The protocol expects each data part to be a JSON array; the client
      // flattens these into `useChat().data`. Mirroring that here so a single
      // writeData({...}) shows up as one element in `data`.
      send(`2:${JSON.stringify([value])}\n`);
    },
    finish(opts) {
      if (finished) return;
      finished = true;
      const payload = {
        finishReason: opts?.finishReason ?? "stop",
        usage: opts?.usage ?? { promptTokens: 0, completionTokens: 0 },
      };
      send(`d:${JSON.stringify(payload)}\n`);
    },
    error(err) {
      const message = err instanceof Error ? err.message : String(err);
      send(`3:${JSON.stringify(message)}\n`);
      this.close();
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        // already closed — ignore
      }
    },
  };

  return { stream, writer };
}
