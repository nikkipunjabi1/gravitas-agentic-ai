"use client";

import { motion } from "framer-motion";
import { GravitasMark } from "@/lib/branding/mark";
import { cn } from "@/lib/utils/cn";
import { canvasEnter } from "@/canvas/motion";
import type { UIAction, UIActionType } from "@/canvas/schema";

/**
 * StubAction — placeholder for canvas component types whose real
 * implementation lands in a later phase.
 *
 * Why this exists:
 *   - The registry is typed as a total map over UIAction["type"]
 *     (UI_CONTRACT.md). Adding a new union member without a component is a
 *     compile error — that's the point.
 *   - Phase 0 only ships <DebugAction>, but we want the schema to be
 *     complete now so subsequent phases just swap stubs for real
 *     components, not invent the contract on the fly.
 *
 * A StubAction renders a small "Coming in Phase N" card plus the payload
 * preview (capped, deterministic). It's intentionally low-effort.
 */
export function StubAction({
  action,
  phase,
}: {
  action: UIAction;
  phase: 1 | 2 | 3;
}) {
  const label = ACTION_LABELS[action.type] ?? action.type;

  return (
    <motion.section
      variants={canvasEnter}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "rounded-2xl border border-dashed border-paper-edge bg-paper",
        "overflow-hidden shadow-sm",
      )}
      aria-label={`Placeholder for ${action.type}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-paper-edge bg-paper-soft px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <GravitasMark size="xs" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {label} · Phase {phase}
          </span>
        </div>
        <span
          className="font-mono text-[10px] text-ink-muted/70"
          title={action.id}
        >
          {action.id.slice(0, 8)}
        </span>
      </header>

      <div className="space-y-2 px-4 py-3">
        <p className="text-sm text-ink-soft">
          This canvas component is implemented in Phase {phase}. The payload below
          is what the agent will hand the real component.
        </p>
        <details className="rounded-md bg-paper-soft/70 px-3 py-2">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-ink-muted">
            Payload preview
          </summary>
          <pre
            className={cn(
              "mt-2 max-h-60 overflow-auto",
              "font-mono text-[11px] leading-relaxed text-ink-soft",
              "whitespace-pre-wrap break-words",
            )}
          >
            {safeStringify(action.data)}
          </pre>
        </details>
      </div>
    </motion.section>
  );
}

// Human-readable labels for each action type. Used here and (later) in the
// admin panel's UIAction filter chips.
const ACTION_LABELS: Record<UIActionType, string> = {
  AuditFindings: "Audit findings",
  MaturityChart: "Maturity chart",
  RoadmapWidget: "Roadmap",
  SolutionMap: "Solution map",
  TechStackReco: "Tech-stack reco",
  LeadGenForm: "Lead-gen form",
  ExecutiveBriefDownload: "Executive brief",
  DailyCapReached: "Daily cap reached",
  KeepAndBuildOn: "Keep & build on",
  ThemesGrid: "Themes grid",
  RateLimitReached: "Rate limit reached",
  DebugAction: "Debug",
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Type-narrow factory: returns a component that satisfies the registry's
 * mapped type (`React.ComponentType<{ action: UIActionOf<K> }>`) while
 * delegating to the broad <StubAction>.
 */
export function makeStub<K extends UIActionType>(
  _type: K,
  phase: 1 | 2 | 3,
): React.ComponentType<{ action: Extract<UIAction, { type: K }> }> {
  return function StubForType({
    action,
  }: {
    action: Extract<UIAction, { type: K }>;
  }) {
    return <StubAction action={action} phase={phase} />;
  };
}
