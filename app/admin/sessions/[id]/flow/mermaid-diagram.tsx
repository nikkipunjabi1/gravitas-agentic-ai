"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client-side Mermaid renderer.
 *
 * Dynamically imports `mermaid` so its ~1.5 MB bundle is only paid for on
 * the /admin Flow page (where the diagram lives), not on every admin
 * navigation. Renders once per `source` change; subsequent re-renders
 * reuse the cached SVG via a unique element id.
 *
 * Note on theme: we initialise with `theme: "neutral"` so the diagram's
 * default palette plays nicely with the Gravitas paper/ink colour scheme.
 * Mermaid's "default" theme uses pastels that clash on cream backgrounds.
 */
export function MermaidDiagram({
  source,
  caption,
}: {
  source: string;
  caption?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderId] = useState(
    () => `mmd-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "loose",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          sequence: {
            actorMargin: 48,
            messageMargin: 32,
            mirrorActors: false,
          },
        });
        const { svg } = await mermaid.render(renderId, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  return (
    <figure className="overflow-hidden rounded-xl border border-paper-edge bg-paper p-4">
      {error ? (
        <div className="text-xs text-severity-critical">
          Diagram render failed: {error}
        </div>
      ) : (
        <div
          ref={ref}
          className="overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full [&_svg]:h-auto"
        />
      )}
      {caption ? (
        <figcaption className="mt-2 text-xs text-ink-soft">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
