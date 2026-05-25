import { z } from "zod";
import { isRouterError } from "@/lib/models";
import {
  createDataStream,
  dataStreamHeaders,
  emitUIAction,
} from "@/lib/stream";
import type { Message } from "@/lib/models";
import {
  appendMessage,
  endSession,
  ensureSession,
} from "@/server/sessions";
import { runTurn } from "@/agents";
import type { VisitorContext } from "@/agents/state";
import type { SessionState } from "@/agents/state";
import {
  consumeTurn,
  extractIp,
  getQuota,
  hashIp,
  getLimits,
} from "@/lib/quota";
import { inspectAndTrack } from "@/lib/guardrails";

/**
 * POST /api/chat — streaming chat endpoint.
 *
 * Pipeline (in order):
 *   1. Validate body.
 *   2. Resolve a stable session id (client supplies it; Phase 1 also creates
 *      a sessions row on first hit).
 *   3. Consume one turn from the per-IP quota. If exhausted, emit a
 *      RateLimitReached UIAction and short-circuit BEFORE the agent runs
 *      (docs/ARCHITECTURE.md → Rate limiting).
 *   4. Run the agent against the writer. Phase 1 = Phase 0 plumbing + IP
 *      quota + persistent session; Phase 1.3+ replaces the body with a real
 *      LangGraph run.
 *
 * Response: Vercel AI SDK Data Stream Protocol v1. Text parts → chat pane;
 * data parts of shape `{ type: "ui-action" }` → canvas pane.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "data"]),
        content: z.string(),
        id: z.string().optional(),
      }),
    )
    .min(1),
  /** Client-generated session id. Reused across the visitor's turns. */
  sessionId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  // ---- 1. Validate ----------------------------------------------------------
  let parsed: z.infer<typeof ChatBody>;
  try {
    const body = (await req.json()) as unknown;
    parsed = ChatBody.parse(body);
  } catch (err) {
    return Response.json(
      { error: "invalid_body", detail: (err as Error).message },
      { status: 400 },
    );
  }

  type ConvoMessage = { role: "user" | "assistant" | "system"; content: string; id?: string };
  const messages: Message[] = parsed.messages
    .filter((m): m is ConvoMessage => m.role !== "data")
    .map((m) => ({ role: m.role, content: m.content }));

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUser?.content ?? "";

  // ---- 2. Session + IP quota setup -----------------------------------------
  const ipRaw = extractIp(req);
  const ipHash = hashIp(ipRaw);
  const userAgent = req.headers.get("user-agent") ?? null;

  // ensureSession is idempotent — turn 1 creates the row, turns 2+ are no-ops.
  // This MUST run before any appendMessage / model_call write or the FK to
  // sessions.id will violate. The client supplies a sessionStorage-backed
  // UUID so the same id arrives on every turn of one session.
  const ensured = await ensureSession({
    id: parsed.sessionId,
    ipHash,
    userAgent,
  });
  const sessionId = ensured.id;

  // ---- 3. Consume one turn -------------------------------------------------
  const quota = await consumeTurn(ipHash);
  if (!quota.accepted) {
    // Build a stream that emits ONLY a RateLimitReached UIAction and a short
    // closing text, then finishes. No agent invocation.
    const limits = await getLimits();
    const { stream, writer } = createDataStream();
    void (async () => {
      try {
        emitUIAction(
          writer,
          {
            type: "RateLimitReached",
            id: crypto.randomUUID(),
            version: 1,
            data: {
              reason: "turns",
              headline: "You've reached today's conversation limit.",
              body:
                `Each visitor gets ${limits.turnLimit} turns per day so the Co-Pilot stays available for everyone. ` +
                "Come back at 00:00 UTC to continue — your conversation will start fresh.",
              remainingResetIn: untilUtcMidnightHumanReadable(),
            },
          },
          { sessionId: sessionId ?? null, node: "rate-limit" },
        );
        writer.writeText(
          "You've used today's turns. The counter resets at 00:00 UTC — come back then.",
        );
        writer.finish();
        if (sessionId) {
          await endSession({ sessionId, terminalNode: "rate_limited" });
        }
      } catch (err) {
        writer.error(err);
      } finally {
        writer.close();
      }
    })();
    return new Response(stream, { headers: dataStreamHeaders() });
  }

  // ---- 4. Profanity guardrail ----------------------------------------------
  // Three-strike rule: any profane turn increments the session's strike
  // count. On strike 3 we suspend the chat. Already-suspended sessions
  // refuse without inspection. See src/lib/guardrails/profanity.ts.
  const guardrail = inspectAndTrack(sessionId, lastUserContent);
  if (guardrail.suspended) {
    const { stream, writer } = createDataStream();
    void (async () => {
      try {
        writer.writeText(
          guardrail.reason === "session_suspended"
            ? "This chat has been suspended. Please reach out to the Gravitas team directly at " +
                (process.env.BRANDING_CLOSING_CONTACT_EMAIL ?? "hello@thisisgravitas.com") +
                " — we'd love to help you in person."
            : "I can't continue this conversation. Gravitas conversations stay constructive — please reach out to our team directly at " +
                (process.env.BRANDING_CLOSING_CONTACT_EMAIL ?? "hello@thisisgravitas.com") +
                " and we'll pick this up there.",
        );
        writer.finish();
        if (sessionId) {
          await endSession({ sessionId, terminalNode: "abandoned" }).catch(() => undefined);
        }
      } catch (err) {
        writer.error(err);
      } finally {
        writer.close();
      }
    })();
    return new Response(stream, { headers: dataStreamHeaders() });
  }
  if (guardrail.profane) {
    // Strikes 1 + 2: warn but continue. The warning replaces the user's
    // content for the LLM call below so we don't echo abusive language
    // back through Claude.
    const remaining = 3 - guardrail.strikes;
    const { stream, writer } = createDataStream();
    void (async () => {
      try {
        writer.writeText(
          `I'd rather keep this conversation respectful — ${remaining} ${remaining === 1 ? "warning" : "warnings"} left before I'll have to hand this off to the Gravitas team. Tell me what you're trying to solve and we'll get there together.`,
        );
        writer.finish();
      } catch (err) {
        writer.error(err);
      } finally {
        writer.close();
      }
    })();
    return new Response(stream, { headers: dataStreamHeaders() });
  }

  // ---- 5. Run the agent ----------------------------------------------------
  const { stream, writer } = createDataStream();

  void runAgent({
    writer,
    messages,
    lastUserContent,
    sessionId,
    ipHash,
    signal: req.signal,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[chat] uncaught error in runAgent", err);
    try {
      writer.error(err);
    } catch {
      /* already closed */
    }
    writer.close();
  });

  return new Response(stream, { headers: dataStreamHeaders() });
}

interface RunAgentArgs {
  writer: ReturnType<typeof createDataStream>["writer"];
  messages: Message[];
  lastUserContent: string;
  sessionId: string;
  ipHash: string;
  signal: AbortSignal | null;
}

async function runAgent({
  writer,
  messages,
  lastUserContent,
  sessionId,
  ipHash,
  signal,
}: RunAgentArgs): Promise<void> {
  let terminalPhase: SessionState["phase"] = "discovery";

  try {
    // Persist the user message — fire-and-forget. Awaiting added ~100-200ms
    // of latency per turn for no downstream benefit (the graph reads
    // userMessage from input, not from the messages table). If the insert
    // fails for any reason, sessions.ts logs it; we still ship the turn.
    if (lastUserContent.trim().length > 0) {
      void appendMessage({ sessionId, role: "user", content: lastUserContent }).catch(
        () => undefined,
      );
    }

    // Debug-keyword smoke marker. Still useful in P1 for verifying the
    // UIAction wire when a Supabase / Chroma outage takes the rest down.
    if (/\bdebug\b/i.test(lastUserContent)) {
      emitUIAction(
        writer,
        {
          type: "DebugAction",
          id: crypto.randomUUID(),
          version: 1,
          data: {
            received: lastUserContent,
            messagesInTurn: messages.length,
            sessionId,
            note: "Smoke — round-tripped through emitUIAction → canvas registry.",
            ts: new Date().toISOString(),
          },
        },
        { sessionId, node: "debug" },
      );
    }

    // Visitor context: Phase 1.3 regenerates per turn from the user message
    // (Discovery's heuristic extractor). The sessions row is updated with the
    // resulting patch, so subsequent turns see the cumulative state IF the
    // route hydrates it — P1.4 adds that hydrate-from-session step when
    // Audit needs the URL the visitor submitted two turns ago.
    const visitor: VisitorContext = {
      industry: null,
      role: null,
      namedProblem: null,
      submittedUrl: null,
    };

    // History = everything EXCEPT the latest user message (which becomes the
    // graph's `userMessage` input).
    const history: Message[] = messages
      .filter(
        (_, idx) =>
          !(idx === messages.length - 1 && messages[messages.length - 1]?.role === "user"),
      )
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const result = await runTurn({
        sessionId,
        ipHash,
        visitor,
        history,
        userMessage: lastUserContent,
        writer,
        signal: signal ?? null,
      });
      terminalPhase = result.terminalPhase;
    } catch (err) {
      if (isRouterError(err)) {
        // eslint-disable-next-line no-console
        console.warn(
          "[chat] graph router error — falling back to streamed acknowledgement:",
          err.message,
        );
      } else {
        // eslint-disable-next-line no-console
        console.error("[chat] graph error", err);
      }
      const text = composeFallback(lastUserContent);
      await streamFallback({ writer, text, signal });
      await appendMessage({
        sessionId,
        role: "assistant",
        content: text,
        emittedByNode: "discovery",
      }).catch(() => undefined);
    }

    writer.finish();
  } catch (err) {
    writer.error(err);
  } finally {
    writer.close();
    // Phase 1.3 ends every turn as "discovery". Phase 1.4 replaces this with
    // the actual terminal node from the graph (Output / CapReached / etc).
    // We don't END the session here yet — multi-turn discovery is the norm.
    // Phase 2 adds an "abandoned" sweep based on idle time. For now, no-op
    // unless the graph reached a real terminal.
    if (terminalPhase === "output" || terminalPhase === "cap-reached" || terminalPhase === "done") {
      await endSession({
        sessionId,
        terminalNode: terminalPhase === "cap-reached" ? "cap_reached" : "output",
      }).catch(() => undefined);
    }
  }
}

/** Compose a fallback acknowledgement when no provider is available. */
function composeFallback(lastUserContent: string): string {
  const trimmed = lastUserContent.trim();
  if (!trimmed) {
    return "I'm here — describe a digital problem, or paste a URL you'd like audited.";
  }
  return `Got it — give me a moment on "${trimmed.slice(0, 120)}". I'll pick it up from where you left off.`;
}

async function streamFallback({
  writer,
  text,
  signal,
}: {
  writer: ReturnType<typeof createDataStream>["writer"];
  text: string;
  signal: AbortSignal | null;
}): Promise<void> {
  const chunks = text.match(/(\s*\S+\s*)/g) ?? [text];
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    writer.writeText(chunk);
    await sleep(24);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Phase 1 helper — "in N hours" until next UTC midnight, human-readable. */
function untilUtcMidnightHumanReadable(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
  if (minutes <= 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

// Expose getQuota for an eventual /api/quota GET (Phase 1.6 admin / composer
// counter). Imported here so it doesn't tree-shake out of the module graph.
export { getQuota };
