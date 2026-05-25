"use client";

import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard, ServiceChip } from "./_shell";

/**
 * SolutionMap — Phase 1.10 real implementation.
 *
 * Renders the mapping from the visitor's phrasing to Gravitas service areas.
 * The agent emits one entry per relevant service; each carries:
 *   - visitorPhrase  — the friction in the visitor's own words
 *   - service        — one of the five Gravitas services
 *   - rationale      — why this service owns the answer
 *   - caseStudyRef   — optional KB-grounded case study slug (Phase 2)
 *
 * Layout: stacked cards, one per mapping. ServiceChip carries the brand
 * label; the visitor phrase is quoted verbatim so the canvas reflects real
 * words from the conversation.
 */
export function SolutionMap({ action }: { action: UIActionOf<"SolutionMap"> }) {
  const { mappings } = action.data;
  return (
    <CanvasCard
      label="Solution map"
      id={action.id}
      meta={`${mappings.length} ${mappings.length === 1 ? "mapping" : "mappings"}`}
    >
      {mappings.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-muted">
          No service mappings yet — they appear after the audit synthesises.
        </p>
      ) : (
        <ul className="divide-y divide-paper-edge">
          {mappings.map((m, i) => (
            <li key={`map-${i}`} className="space-y-2 px-4 py-3.5">
              <p className="text-sm leading-snug text-ink">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Your words ·{" "}
                </span>
                <span className="italic">&ldquo;{m.visitorPhrase}&rdquo;</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  Owned by
                </span>
                <ServiceChip service={m.service} />
              </div>
              <p className="text-xs leading-relaxed text-ink-soft">
                {m.rationale}
              </p>
              {m.caseStudyRef ? (
                <p className="font-mono text-[10px] uppercase tracking-widest text-accent">
                  Related case study · {m.caseStudyRef}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CanvasCard>
  );
}
