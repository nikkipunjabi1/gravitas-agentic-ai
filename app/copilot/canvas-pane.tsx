"use client";

import { CanvasDispatcher } from "@/canvas/dispatcher";
import type { UIAction } from "@/canvas/schema";
import { GravitasMark } from "@/lib/branding/mark";
import { cn } from "@/lib/utils/cn";

/**
 * CanvasPane — the right side of /copilot.
 *
 * Renders the stack of validated UIActions emitted by the agent. The stack
 * grows top → bottom in emission order; replace-semantics (same id) swap
 * a component in place. See UI_CONTRACT.md → Replacing vs. appending.
 *
 * Header carries two actions when the pane is populated:
 *   - Print — opens browser print dialog (uses the print stylesheet in
 *     globals.css to show only the canvas).
 *   - Close — clears the actions stack; chat goes full-width.
 *
 * Footer pins a Gravitas badge at the bottom of the scroll area so the
 * report always closes with the brand mark — visible in both screen + print.
 */
export function CanvasPane({
  actions,
  isStreaming,
  onClose,
}: {
  actions: UIAction[];
  isStreaming: boolean;
  onClose?: () => void;
}) {
  return (
    <div
      data-print-target="canvas"
      className="flex h-[calc(100vh-7.5rem)] min-h-[28rem] flex-col"
    >
      <div className="flex items-center justify-between gap-3 border-b border-paper-edge bg-paper px-5 py-3 print:hidden">
        <div className="flex items-center gap-2.5">
          <GravitasMark
            size="xs"
            className={cn(isStreaming && "animate-pulse-soft")}
          />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Canvas · {actions.length} {actions.length === 1 ? "action" : "actions"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              <ThinkingDots /> running
            </span>
          ) : null}
          {actions.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-full border border-paper-edge px-3 py-1 text-[11px] font-medium text-ink-soft transition hover:border-ink-muted hover:text-ink"
                title="Print or save this report as PDF"
              >
                Print / Save as PDF
              </button>
              {onClose ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close canvas"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-paper-edge text-ink-soft transition hover:border-ink-muted hover:text-ink"
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
                    <path
                      d="M3 3 L13 13 M13 3 L3 13"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {actions.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            <CanvasDispatcher actions={actions} />
            <CanvasFooter />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Animated three-dot indicator. Pure CSS via Tailwind keyframes registered
 * in tailwind.config.ts (`animate-bounce-1/2/3` — staggered phase delays).
 * Sized to inherit text color via currentColor so it blends with whatever
 * label sits beside it.
 */
function ThinkingDots() {
  return (
    <span
      aria-label="working"
      role="status"
      className="inline-flex items-center gap-0.5"
    >
      <span className="inline-block h-1 w-1 animate-bounce-dot-1 rounded-full bg-current" />
      <span className="inline-block h-1 w-1 animate-bounce-dot-2 rounded-full bg-current" />
      <span className="inline-block h-1 w-1 animate-bounce-dot-3 rounded-full bg-current" />
    </span>
  );
}

function CanvasFooter() {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-paper-edge pt-4 text-[11px] text-ink-muted">
      <GravitasMark size="sm" />
      <span className="font-mono uppercase tracking-widest">
        thisisgravitas.com
      </span>
    </footer>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm space-y-3 text-center">
        <p className="font-display text-lg font-medium text-ink-soft">
          The canvas is quiet — for now.
        </p>
        <p className="text-sm text-ink-muted">
          When I have something visual to show — an audit, a roadmap, a maturity
          chart — it appears here. Paste a URL in the chat to start.
        </p>
      </div>
    </div>
  );
}
