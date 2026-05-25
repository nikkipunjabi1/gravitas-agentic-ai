"use client";

import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard } from "./_shell";

/**
 * RateLimitReached — Phase 1 canvas component.
 *
 * Per-IP daily quota exhausted (chat turns OR audits). Distinct from
 * DailyCapReached (global $50 cap, lead capture). This card is informational
 * only — no form, no email capture. Anti-abuse signal, not lead capture.
 *
 * The action's `remainingResetIn` is a pre-composed human-readable string
 * ("in 6 hours") computed server-side at emission time. We don't recompute
 * client-side — that would make the component non-deterministic.
 */
export function RateLimitReached({
  action,
}: {
  action: UIActionOf<"RateLimitReached">;
}) {
  const { reason, headline, body, remainingResetIn } = action.data;
  return (
    <CanvasCard
      label={reason === "audits" ? "Daily audit used" : "Daily turns used"}
      id={action.id}
      meta={`Resets ${remainingResetIn}`}
      tone="warning"
    >
      <div className="space-y-3 px-4 py-4">
        <h3 className="font-display text-base font-semibold leading-snug text-ink">
          {headline}
        </h3>
        <p className="text-sm leading-relaxed text-ink-soft">{body}</p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Counter resets {remainingResetIn} at 00:00 UTC
        </p>
      </div>
    </CanvasCard>
  );
}
