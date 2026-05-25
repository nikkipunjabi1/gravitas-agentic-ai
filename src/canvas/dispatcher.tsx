"use client";

import { AnimatePresence } from "framer-motion";
import { registry } from "@/canvas/registry";
import type { UIAction } from "@/canvas/schema";

/**
 * CanvasDispatcher — given a validated UIAction, look up the component in
 * the registry and render it. The discriminated union plus the typed
 * registry make this dispatch type-safe; the `as never` below is the one
 * unavoidable cast that bridges the mapped-type lookup to a concrete render.
 *
 * Why a separate dispatcher (rather than inlining in the page):
 *   - Single place to wrap each action in <AnimatePresence> so replace
 *     semantics (same id → swap component) animate cleanly.
 *   - Single place to add the dev-mode "tool-call" debug overlay later.
 */
export function CanvasDispatcher({ actions }: { actions: UIAction[] }) {
  return (
    <AnimatePresence initial={false}>
      {actions.map((action) => {
        const Component = registry[action.type] as React.ComponentType<{
          action: UIAction;
        }>;
        // `key` uses the action id so a "replace" (same id, new payload)
        // remounts the component cleanly. UI_CONTRACT.md → Replacing vs.
        // appending.
        return <Component key={action.id} action={action as never} />;
      })}
    </AnimatePresence>
  );
}
