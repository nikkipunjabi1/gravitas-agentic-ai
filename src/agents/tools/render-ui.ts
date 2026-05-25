import { emitUIAction } from "@/lib/stream/ui-action";
import type { DataStreamWriter } from "@/lib/stream/data-stream";
import type { UIAction } from "@/canvas/schema";

/**
 * render-ui — the tool agents use to push a typed UIAction onto the canvas.
 *
 * This is the ONE callsite agents touch when they want to render something.
 * It delegates to `emitUIAction` so validation + logging happen in exactly
 * one place (CLAUDE.md → "Bypass the logging chokepoint" guardrail).
 *
 * The returned id lets the calling node track what's been emitted via
 * SessionState.uiActionsEmitted, supporting replace semantics on retries.
 */
export function renderUI(
  writer: DataStreamWriter,
  action: UIAction,
  meta: { sessionId: string; node: string },
): { emittedId: string } {
  emitUIAction(writer, action, meta);
  return { emittedId: action.id };
}
