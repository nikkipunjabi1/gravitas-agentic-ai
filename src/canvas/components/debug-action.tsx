"use client";

import { motion } from "framer-motion";
import { GravitasMark } from "@/lib/branding/mark";
import { cn } from "@/lib/utils/cn";
import { canvasEnter } from "@/canvas/motion";
import type { UIActionOf } from "@/canvas/schema";

/**
 * DebugAction — Phase 0 smoke component.
 *
 * Renders the raw payload as pretty-printed JSON. Used to verify the
 * agent → stream → canvas wire end-to-end before any real action type
 * has a real component. See ROADMAP.md → Phase 0 DoD.
 *
 * Component rules satisfied (UI_CONTRACT.md):
 *   1. Marked "use client" — has motion + interactivity (collapsible).
 *   2. Accepts exactly `{ action }`.
 *   3. Deterministic render from `action.data` alone.
 *   4. Tailwind theme classes only.
 *   5. canvasEnter animation.
 */
export function DebugAction({ action }: { action: UIActionOf<"DebugAction"> }) {
  const json = safeStringify(action.data);

  return (
    <motion.section
      variants={canvasEnter}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "rounded-2xl border border-paper-edge bg-paper-soft shadow-sm",
        "overflow-hidden",
      )}
      aria-label="Debug action"
    >
      <header className="flex items-center justify-between gap-3 border-b border-paper-edge bg-paper px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <GravitasMark size="xs" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Debug · {action.type} · v{action.version}
          </span>
        </div>
        <span
          className="font-mono text-[10px] text-ink-muted/70"
          title={action.id}
        >
          {action.id.slice(0, 8)}
        </span>
      </header>

      <pre
        className={cn(
          "max-h-96 overflow-auto px-4 py-3",
          "font-mono text-[12px] leading-relaxed text-ink-soft",
          "whitespace-pre-wrap break-words",
        )}
      >
        {json}
      </pre>
    </motion.section>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
