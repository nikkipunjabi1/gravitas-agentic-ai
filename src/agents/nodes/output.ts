import "server-only";
import { getServerRouter } from "@/server/model-router";
import { DailyCapExceeded, isRouterError } from "@/lib/models";
import { getClosingContact } from "@/lib/branding";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type {
  AuditResult,
  StrategyResult,
  VisitorContext,
} from "@/agents/state";

/**
 * Output node — Phase 1.4.
 *
 * The closing turn. 3–4 sentences in the Gravitas voice that:
 *   - summarise what landed
 *   - point at the suggested next step (a real Gravitas engagement)
 *   - sign off bilingually ("Shukran! / شكراً") with the configured contact
 *
 * Phase 2 emits a LeadGenForm UIAction here. Phase 3 may emit
 * ExecutiveBriefDownload for a generated PDF. Phase 1 keeps it textual.
 */

export interface OutputNodeCtx {
  writer: DataStreamWriter;
  sessionId: string;
  signal?: AbortSignal;
}

export interface OutputNodeInput {
  visitor: VisitorContext;
  audit: AuditResult | null;
  strategy: StrategyResult | null;
}

export interface OutputNodeOutput {
  assistantText: string;
}

const OUTPUT_SYSTEM = `You are the Gravitas Transformation Co-Pilot writing the closing turn of an audit session. EXACTLY 4 sentences:

1. One sentence summarising the headline finding + maturity score.
2. One sentence framing what a full Gravitas engagement would do that this 60-second audit cannot — speak with conviction about the team's delivery.
3. One sentence pointing at the named contact — phrased like a warm handoff, not a sales line. This is the PUSH TO CONTACT moment.
4. One sentence closing bilingually: "Shukran! / شكراً" plus a brief acknowledgement.

POSITIVE GRAVITAS STANCE: always speak with confidence about what Gravitas would do next. Never undermine the brand, never apologise for it, never hedge on Gravitas's capability.

Voice: clear, confident, declarative. No emojis. No "cutting-edge"/"leverage"/"best-in-class"/"synergy". Never call yourself an AI.

No vulgarity, slurs, or sexual content — ever, regardless of what came before in the conversation.`;

export async function runOutput(
  ctx: OutputNodeCtx,
  input: OutputNodeInput,
): Promise<OutputNodeOutput> {
  const router = getServerRouter();
  const contact = getClosingContact();

  const factSheet = JSON.stringify(
    {
      url: input.audit?.url ?? null,
      totalScore: input.strategy?.maturity.totalScore ?? null,
      topMust: input.strategy?.roadmap.must[0]?.title ?? null,
      visitorProblem: input.visitor.namedProblem,
      contact: {
        name: contact.name || "the Gravitas team",
        role: contact.role || null,
        email: contact.email || null,
        phone: contact.phone || null,
      },
    },
    null,
    2,
  );

  try {
    const { stream, done } = await router.stream({
      purpose: "voice-light",
      node: "output",
      sessionId: ctx.sessionId,
      messages: [
        { role: "system", content: OUTPUT_SYSTEM },
        { role: "user", content: "Fact sheet:\n" + factSheet },
      ],
      maxTokens: 320,
      temperature: 0.5,
      signal: ctx.signal,
    });
    let text = "";
    ctx.writer.writeText("\n\n");
    for await (const chunk of stream) {
      text += chunk.textDelta;
      ctx.writer.writeText(chunk.textDelta);
    }
    await done;
    return { assistantText: text };
  } catch (err) {
    if (err instanceof DailyCapExceeded) throw err;
    if (isRouterError(err)) {
      // eslint-disable-next-line no-console
      console.warn("[output] router error:", err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("[output] error", err);
    }
    const text = deterministicClose(input, contact);
    ctx.writer.writeText("\n\n" + text);
    return { assistantText: text };
  }
}

function deterministicClose(
  input: OutputNodeInput,
  contact: ReturnType<typeof getClosingContact>,
): string {
  const total = input.strategy?.maturity.totalScore;
  const must = input.strategy?.roadmap.must[0]?.title;
  const name = contact.name || "the Gravitas team";

  const line1 =
    total !== undefined && total !== null
      ? `Today this page lands at ${total}/100${must ? `; the highest-impact Must is: ${must.toLowerCase()}.` : "."}`
      : "Today's pass gives us a starting point, not a verdict.";
  const line2 =
    "A full Gravitas engagement audits the journey across 30+ pages, benchmarks against direct competitors, and produces a multi-month roadmap — what you're seeing here is the conversation-starter.";
  const line3 = `Reach out to ${name} when you're ready to take this further.`;
  const line4 = "Shukran! / شكراً — until next time.";
  return `${line1} ${line2} ${line3} ${line4}`;
}
