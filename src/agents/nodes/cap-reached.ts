import "server-only";
import { renderUI } from "@/agents/tools/render-ui";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type { VisitorContext } from "@/agents/state";

/**
 * CapReached terminal node — Phase 1.4.
 *
 * Reached when any prior node threw `DailyCapExceeded` (router refused a
 * voice-heavy call because the $50/day Anthropic cap was hit).
 *
 * IMPORTANT: this node makes ZERO model calls. Doing so would loop on the
 * very provider we're trying to avoid — and the cap is set up precisely to
 * prevent that loop. Composition is a static template that mirrors the
 * Gravitas voice rules without any inference.
 *
 * Behaviour:
 *   - Stream a static Gravitas-voiced acknowledgement.
 *   - Emit a `DailyCapReached` UIAction with email capture. Phase 1 only
 *     captures the email (writes to `waitlist`); Phase 2 sends a "we're
 *     back" email the next day. The waitlist insert lives on the
 *     /api/waitlist endpoint, not here — keeping this node side-effect-free
 *     beyond the writer.
 *
 * See docs/AGENTS.md → CapReached and docs/ARCHITECTURE.md → Cost cap.
 */

export interface CapReachedCtx {
  writer: DataStreamWriter;
  sessionId: string;
}

export interface CapReachedInput {
  visitor: VisitorContext;
}

export interface CapReachedOutput {
  assistantText: string;
}

export function runCapReached(
  ctx: CapReachedCtx,
  input: CapReachedInput,
): CapReachedOutput {
  const url = input.visitor.submittedUrl;

  renderUI(
    ctx.writer,
    {
      type: "DailyCapReached",
      id: crypto.randomUUID(),
      version: 1,
      data: {
        headline: "We've used our model budget for today.",
        body:
          "The Co-Pilot runs a daily spend ceiling so it stays sustainable — and the ceiling has just been reached. " +
          "Leave an email and we'll let you know the moment the next day's budget is available so we can pick this up.",
        emailFieldLabel: "Email",
        submitLabel: "Notify me when we're back",
        sessionId: ctx.sessionId,
        intendedUrl: url ?? null,
      },
    },
    { sessionId: ctx.sessionId, node: "cap-reached" },
  );

  // Static Gravitas-voiced acknowledgement — NO model call.
  const text = composeStaticAck(input);
  ctx.writer.writeText("\n\n" + text);
  return { assistantText: text };
}

function composeStaticAck(input: CapReachedInput): string {
  const namedProblem = input.visitor.namedProblem;
  const opener = namedProblem
    ? `I have what you said — "${truncate(namedProblem, 100)}" — and the audit context still ready to pick up from. `
    : "I have the thread of what we were doing and we can pick up from there. ";
  return (
    opener +
    "We just hit today's model-spend ceiling, which is the limit that keeps the Co-Pilot honest about cost. " +
    "Leave an email above and you'll hear from us the moment the next day's budget resets. " +
    "Shukran! / شكراً — back tomorrow."
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
