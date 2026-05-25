"use client";

import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard, LensChip } from "./_shell";

/**
 * KeepAndBuildOn — Phase 1 canvas component.
 *
 * Positive findings rendered BEFORE critique per the Gravitas methodology.
 * The action carries 2–4 substantive strengths (validated by zod min/max)
 * and up to 5 short "also working" bullets.
 *
 * Voice rule (docs/BRANDING.md → Strength framing):
 *   "This is a genuine [competitive strength / starting point].
 *    Use this as the internal benchmark."
 * The composing node provides those words; this component just renders.
 */

export function KeepAndBuildOn({
  action,
}: {
  action: UIActionOf<"KeepAndBuildOn">;
}) {
  const { strengths, alsoWorking } = action.data;

  return (
    <CanvasCard
      label="Keep & build on"
      id={action.id}
      meta={`${strengths.length} ${strengths.length === 1 ? "strength" : "strengths"}`}
      tone="accent"
    >
      <div className="space-y-4 px-4 py-4">
        <ul className="grid gap-3 md:grid-cols-2">
          {strengths.map((s, i) => (
            <li
              key={`s-${i}`}
              className="rounded-xl border border-paper-edge bg-paper p-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-sm font-semibold leading-snug text-ink">{s.title}</h4>
                <LensChip lens={s.lens} />
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.detail}</p>
            </li>
          ))}
        </ul>

        {alsoWorking.length > 0 ? (
          <section className="rounded-lg border border-paper-edge bg-paper-soft/60 p-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Also working
            </p>
            <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-ink-soft">
              {alsoWorking.map((bullet, i) => (
                <li key={`b-${i}`}>{bullet}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </CanvasCard>
  );
}
