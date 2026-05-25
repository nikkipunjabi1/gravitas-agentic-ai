"use client";

import { motion } from "framer-motion";
import { GravitasMark } from "@/lib/branding/mark";
import { cn } from "@/lib/utils/cn";
import { canvasEnter } from "@/canvas/motion";

/**
 * <CanvasCard> — shared shell for every canvas component.
 *
 * Three responsibilities:
 *   1. Animate on mount via the shared canvasEnter variant.
 *   2. Apply the Gravitas card chrome (border, surface, radius, padding).
 *   3. Render the standard header — Gravitas mark + label + truncated id.
 *
 * Why hoist this:
 *   - Every Phase-1 canvas component shares the same outer shape; copy-pasting
 *     it 7 times invites drift (someone changes border radius in one place).
 *   - Phase 2 components (LeadGenForm, SolutionMap, TechStackReco) plug into
 *     the same shell without re-deriving the chrome rules.
 */
export function CanvasCard({
  label,
  id,
  meta,
  tone = "default",
  children,
}: {
  label: string;
  id: string;
  meta?: React.ReactNode;
  tone?: "default" | "warning" | "accent";
  children: React.ReactNode;
}) {
  return (
    <motion.section
      variants={canvasEnter}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "overflow-hidden rounded-2xl border shadow-sm",
        tone === "default" && "border-paper-edge bg-paper-soft",
        tone === "accent" && "border-accent/30 bg-paper",
        tone === "warning" && "border-severity-high/40 bg-paper",
      )}
      aria-label={label}
    >
      <header className="flex items-center justify-between gap-3 border-b border-paper-edge bg-paper px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <GravitasMark size="xs" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {meta ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {meta}
            </span>
          ) : null}
          <span
            className="font-mono text-[10px] text-ink-muted/70"
            title={id}
          >
            {id.slice(0, 8)}
          </span>
        </div>
      </header>
      <div>{children}</div>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Shared display helpers
// ---------------------------------------------------------------------------

const LENS_LABEL: Record<string, string> = {
  usability: "D1 · Usability",
  "user-needs": "D2 · User Needs",
  conversion: "D3 · Conversion",
  "design-execution": "D4 · Design Execution",
};

const LENS_COLOR_CLASS: Record<string, string> = {
  usability: "bg-lens-usability/10 text-lens-usability border-lens-usability/30",
  "user-needs": "bg-lens-user-needs/10 text-lens-user-needs border-lens-user-needs/30",
  conversion: "bg-lens-conversion/10 text-lens-conversion border-lens-conversion/30",
  "design-execution":
    "bg-lens-design-execution/10 text-lens-design-execution border-lens-design-execution/30",
};

const LENS_DOT_CLASS: Record<string, string> = {
  usability: "bg-lens-usability",
  "user-needs": "bg-lens-user-needs",
  conversion: "bg-lens-conversion",
  "design-execution": "bg-lens-design-execution",
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: "bg-severity-critical/10 text-severity-critical border-severity-critical/30",
  high: "bg-severity-high/10 text-severity-high border-severity-high/30",
  medium: "bg-severity-medium/10 text-severity-medium border-severity-medium/30",
  low: "bg-severity-low/10 text-severity-low border-severity-low/30",
};

const SERVICE_LABEL: Record<string, string> = {
  "experience-strategy-design": "Experience Strategy & Design",
  "product-design-engineering": "Product Design & Engineering",
  "service-design-operations": "Service Design & Operations",
  "ai-data-automation": "AI, Data & Automation",
  "capability-enablement": "Capability & Enablement",
};

export function LensChip({ lens }: { lens: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        LENS_COLOR_CLASS[lens] ?? "border-paper-edge bg-paper-soft text-ink-muted",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", LENS_DOT_CLASS[lens] ?? "bg-ink-muted")} />
      {LENS_LABEL[lens] ?? lens}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        SEVERITY_CLASS[severity] ?? "border-paper-edge bg-paper-soft text-ink-muted",
      )}
    >
      {severity}
    </span>
  );
}

export function ServiceChip({ service }: { service: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-ink/15 bg-paper px-2 py-0.5 text-[10px] font-medium text-ink-soft">
      {SERVICE_LABEL[service] ?? service}
    </span>
  );
}

export function getLensLabel(lens: string): string {
  return LENS_LABEL[lens] ?? lens;
}

export function getServiceLabel(service: string): string {
  return SERVICE_LABEL[service] ?? service;
}
