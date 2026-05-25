"use client";

import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard } from "./_shell";

/**
 * ThemesGrid — Phase 1 canvas component.
 *
 * 4–6 cross-cutting patterns that span lenses (validated by the schema's
 * min/max). Rendered as a 2-column grid on wide; single column on narrow.
 * No icons — themes are conceptual; type carries the weight.
 */
export function ThemesGrid({ action }: { action: UIActionOf<"ThemesGrid"> }) {
  const { themes } = action.data;

  return (
    <CanvasCard
      label="Cross-cutting themes"
      id={action.id}
      meta={`${themes.length} ${themes.length === 1 ? "theme" : "themes"}`}
    >
      <ul className="grid gap-3 px-4 py-4 md:grid-cols-2">
        {themes.map((t, i) => (
          <li
            key={`t-${i}`}
            className="rounded-xl border border-paper-edge bg-paper p-3.5"
          >
            <h4 className="text-sm font-semibold leading-snug text-ink">{t.title}</h4>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t.body}</p>
          </li>
        ))}
      </ul>
    </CanvasCard>
  );
}
