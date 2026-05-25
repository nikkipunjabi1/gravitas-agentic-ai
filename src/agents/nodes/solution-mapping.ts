import "server-only";
import { renderUI } from "@/agents/tools/render-ui";
import { deriveSolutionMappings, getServiceLabel } from "@/agents/findings";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type { AuditResult, SolutionMap, VisitorContext } from "@/agents/state";

/**
 * Solution Mapping node — Phase 1.4.
 *
 * The mapping table is hard-coded (docs/AGENTS.md → Solution Mapping). The
 * agent doesn't classify here — the findings ALREADY carry their
 * gravitasService tag from the Audit node (deriveFindings). This node just
 * groups + composes the SolutionMap payload + emits.
 *
 * Voice: a single short paragraph framing the mapping. Uses Ollama Qwen3
 * via the router's `classify` purpose to keep cost predictable (or templated
 * if the router is unavailable).
 *
 * Phase 2 swap: when KB grounding has real case-study coverage, populate
 * `caseStudyRef` per mapping by querying KB for the service area.
 */

export interface SolutionMappingCtx {
  writer: DataStreamWriter;
  sessionId: string;
  signal?: AbortSignal;
}

export interface SolutionMappingInput {
  visitor: VisitorContext;
  audit: AuditResult | null;
}

export interface SolutionMappingOutput {
  solutionMap: SolutionMap;
  assistantText: string;
}

export async function runSolutionMapping(
  ctx: SolutionMappingCtx,
  input: SolutionMappingInput,
): Promise<SolutionMappingOutput> {
  const findings = input.audit?.findings ?? [];
  const mappings = deriveSolutionMappings(findings, input.visitor.namedProblem);

  // Empty audits still produce a map: pivot to a generic mapping of the
  // visitor's named problem to a single service so the canvas component has
  // something to render. Phase 2 may suppress emission instead.
  const safeMappings =
    mappings.length > 0
      ? mappings
      : [
          {
            visitorPhrase:
              input.visitor.namedProblem ??
              "A digital experience that could be sharper across the journey",
            service: "experience-strategy-design" as const,
            rationale:
              "Without findings to anchor to, this is the natural starting point — Experience Strategy & Design owns the cross-cutting view.",
            caseStudyRef: null,
          },
        ];

  const payload: SolutionMap = { mappings: safeMappings };

  renderUI(
    ctx.writer,
    {
      type: "SolutionMap",
      id: crypto.randomUUID(),
      version: 1,
      data: { mappings: safeMappings },
    },
    { sessionId: ctx.sessionId, node: "solution-mapping" },
  );

  // Brief narration — templated rather than LLM-composed. Keeps cost down
  // and avoids drifting from the canvas component's exact contents.
  const services = safeMappings.map((m) => getServiceLabel(m.service));
  const text = composeNarration(services);
  ctx.writer.writeText("\n\n" + text);

  return { solutionMap: payload, assistantText: text };
}

function composeNarration(services: string[]): string {
  if (services.length === 0) {
    return "Mapping the issues to Gravitas services in the canvas.";
  }
  if (services.length === 1) {
    return `Mapped this one to ${services[0]} — that's the engagement that owns the answer.`;
  }
  const head = services.slice(0, -1).join(", ");
  const tail = services[services.length - 1];
  return `Mapped these to ${head} and ${tail} — each is its own Gravitas engagement, but they connect in the redesign.`;
}
