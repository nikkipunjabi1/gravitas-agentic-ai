import { UIAction } from "@/canvas/schema";
import type { DataStreamWriter } from "./data-stream";

/**
 * The single chokepoint for emitting a UIAction over the chat stream.
 *
 * Two responsibilities (CLAUDE.md → "Bypass the logging chokepoint"):
 *   1. Validate every action against the zod schema. Invalid actions are
 *      dropped + logged — never reach the canvas.
 *   2. (Phase 1+) Persist the validated action to `ui_actions_emitted`
 *      alongside emitting it. Phase 0 stubs this as a structured console log.
 *
 * Agent code MUST go through this function. A `writer.writeData({ type:
 * "ui-action", ... })` callsite anywhere else is a bug.
 */
export function emitUIAction(
  writer: DataStreamWriter,
  action: UIAction,
  meta?: { sessionId?: string; node?: string },
): void {
  const parsed = UIAction.safeParse(action);
  if (!parsed.success) {
    // Drop + log. The agent will NOT retry — treat as a bug in the emitter.
    // eslint-disable-next-line no-console
    console.error(
      "[ui_actions_emitted] invalid UIAction dropped",
      JSON.stringify({
        sessionId: meta?.sessionId ?? null,
        node: meta?.node ?? null,
        action_type: (action as { type?: string } | undefined)?.type ?? null,
        issues: parsed.error.issues,
      }),
    );
    return;
  }

  // The cast to `unknown` (then `JSONValue` via the writer's accepted type) is
  // safe: zod just validated `parsed.data` against the UIAction union and
  // every value in that union is JSON-serializable by construction. The cast
  // bridges a type-level gap (UIAction's `data: unknown` arm vs the writer's
  // structural JSONValue), not a runtime one.
  writer.writeData({ type: "ui-action", action: parsed.data } as unknown as Parameters<DataStreamWriter["writeData"]>[0]);

  // ---- Logging hook ------------------------------------------------------
  // Phase 0: structured console.log so dev can grep for it.
  // Phase 1: replace with an insert into `ui_actions_emitted`. The Supabase
  //          sink can read the same shape this function logs.
  // eslint-disable-next-line no-console
  console.log(
    "[ui_actions_emitted] " +
      JSON.stringify({
        kind: "ui_action",
        session_id: meta?.sessionId ?? null,
        node: meta?.node ?? null,
        action_id: parsed.data.id,
        action_type: parsed.data.type,
        ts: new Date().toISOString(),
      }),
  );
}
