"use client";

import { cn } from "@/lib/utils/cn";
import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard, ServiceChip } from "./_shell";

/**
 * RoadmapWidget — Phase 1 canvas component.
 *
 * Two modes per the wire contract:
 *   "priority" — Must / Should / Could (Gravitas audit convention)
 *   "horizons" — Quick wins / Next 90 days / 6–12 months (time-based)
 *
 * Phase 1 emits "priority" mode exclusively; "horizons" mode is supported
 * here so Phase 2's Strategy variants don't need a component change.
 *
 * Layout: 3 columns on wide; stacked on narrow. Each column tone-colored
 * by its priority/horizon.
 */

type Data = UIActionOf<"RoadmapWidget">["data"];
type Group = Data["groups"][number];

export function RoadmapWidget({ action }: { action: UIActionOf<"RoadmapWidget"> }) {
  const { mode, groups } = action.data;
  const total = groups.reduce((s, g) => s + g.items.length, 0);

  return (
    <CanvasCard
      label={mode === "priority" ? "Recommendations" : "Roadmap"}
      id={action.id}
      meta={`${total} ${total === 1 ? "item" : "items"} · ${mode === "priority" ? "Must · Should · Could" : "Horizons"}`}
    >
      <div className="grid gap-3 px-4 py-4 md:grid-cols-3">
        {groups.map((group) => (
          <Column key={group.label} group={group} mode={mode} />
        ))}
      </div>
    </CanvasCard>
  );
}

function Column({ group, mode }: { group: Group; mode: Data["mode"] }) {
  const tone = labelTone(group.label, mode);
  return (
    <section
      className={cn(
        "rounded-xl border bg-paper",
        tone === "must" && "border-severity-critical/30",
        tone === "should" && "border-severity-medium/30",
        tone === "could" && "border-lens-user-needs/30",
      )}
    >
      <header
        className={cn(
          "flex items-center justify-between border-b px-3 py-2",
          tone === "must" && "border-severity-critical/30 bg-severity-critical/5",
          tone === "should" && "border-severity-medium/30 bg-severity-medium/5",
          tone === "could" && "border-lens-user-needs/30 bg-lens-user-needs/5",
        )}
      >
        <span
          className={cn(
            "text-xs font-semibold uppercase tracking-wide",
            tone === "must" && "text-severity-critical",
            tone === "should" && "text-severity-medium",
            tone === "could" && "text-lens-user-needs",
          )}
        >
          {group.label}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {group.items.length}
        </span>
      </header>
      {group.items.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-ink-muted">
          No items in this bucket — that&apos;s a clean signal.
        </p>
      ) : (
        <ul className="divide-y divide-paper-edge">
          {group.items.map((item, i) => (
            <li key={`${group.label}-${i}`} className="px-3 py-3">
              <p className="text-sm font-semibold leading-snug text-ink">{item.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-soft">{item.why}</p>
              <div className="mt-2">
                <ServiceChip service={item.gravitasService} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function labelTone(label: Group["label"], mode: Data["mode"]): "must" | "should" | "could" {
  if (mode === "priority") {
    if (label === "Must") return "must";
    if (label === "Should") return "should";
    return "could";
  }
  // horizons mapping
  if (label === "Quick wins") return "must";
  if (label === "Next 90 days") return "should";
  return "could";
}
