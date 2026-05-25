"use client";

import { cn } from "@/lib/utils/cn";
import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard, LensChip, SeverityChip, ServiceChip, getLensLabel } from "./_shell";

/**
 * AuditFindings — Phase 1 canvas component.
 *
 * Groups findings by the Four-Lens framework (D1 Usability / D2 User Needs /
 * D3 Conversion / D4 Design Execution). Each lens group renders findings
 * sorted by severity (the parent state already pre-sorted; we just group).
 *
 * Display rules (docs/BRANDING.md → Findings convention):
 *   - title is the issue, not the fix
 *   - detail explains why it matters
 *   - severity chip + Gravitas-service chip on every card
 *   - empty lens groups are hidden, not shown empty
 */

type Finding = UIActionOf<"AuditFindings">["data"]["findings"][number];

const LENS_ORDER: Finding["lens"][] = [
  "usability",
  "user-needs",
  "conversion",
  "design-execution",
];

export function AuditFindings({
  action,
}: {
  action: UIActionOf<"AuditFindings">;
}) {
  const { findings } = action.data;
  const grouped = groupByLens(findings);

  return (
    <CanvasCard
      label="Audit findings"
      id={action.id}
      meta={`${findings.length} ${findings.length === 1 ? "finding" : "findings"}`}
    >
      {findings.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="divide-y divide-paper-edge">
          {LENS_ORDER.map((lens) => {
            const items = grouped.get(lens);
            if (!items || items.length === 0) return null;
            return <LensGroup key={lens} lens={lens} items={items} />;
          })}
        </div>
      )}
    </CanvasCard>
  );
}

function LensGroup({ lens, items }: { lens: Finding["lens"]; items: Finding[] }) {
  return (
    <section className="space-y-3 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <LensChip lens={lens} />
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {items.length} {items.length === 1 ? "issue" : "issues"}
        </span>
      </div>
      <ul className="space-y-2.5">
        {items.map((f) => (
          <li key={f.id}>
            <FindingCard finding={f} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <article
      className={cn(
        "rounded-xl border border-paper-edge bg-paper p-3.5",
        "transition hover:border-ink-muted/40",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold leading-snug text-ink">
          {finding.title}
        </h4>
        <SeverityChip severity={finding.severity} />
      </header>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{finding.detail}</p>
      {finding.gravitasService ? (
        <footer className="mt-3 flex items-center gap-2 text-[10px] text-ink-muted">
          <span className="font-mono uppercase tracking-widest">Maps to</span>
          <ServiceChip service={finding.gravitasService} />
        </footer>
      ) : null}
    </article>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm text-ink-soft">
        No critical issues surfaced on this single-page pass.
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        That&apos;s calibrated — most pages score &ldquo;Developing&rdquo; here. A full Gravitas
        engagement audits 30+ pages across personas to see what this can&apos;t.
      </p>
    </div>
  );
}

function groupByLens(findings: Finding[]): Map<Finding["lens"], Finding[]> {
  const map = new Map<Finding["lens"], Finding[]>();
  for (const f of findings) {
    const arr = map.get(f.lens);
    if (arr) arr.push(f);
    else map.set(f.lens, [f]);
  }
  return map;
}

// Re-export helper for any sibling that wants the lens label.
export { getLensLabel };
