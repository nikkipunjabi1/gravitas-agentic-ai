"use client";

import { cn } from "@/lib/utils/cn";
import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard } from "./_shell";

/**
 * MaturityChart — Phase 1 canvas component.
 *
 * Four-Lens radar — 4 axes at 90° increments, plotted on a normalized 0–10
 * scale (the action carries both raw and normalized scores). Rendered as an
 * inline SVG so it scales cleanly and doesn't need a chart library.
 *
 * Layout (docs/BRANDING.md → Four-Lens Framework):
 *
 *           Usability Standards
 *                  ▲
 *                  │
 *  User Needs ─────●───── Design Execution
 *                  │
 *                  ▼
 *              Conversion
 *
 * Axis ordering on the SVG (clockwise from top):
 *   D1 Usability       → 12 o'clock
 *   D4 Design Execution → 3 o'clock
 *   D3 Conversion      → 6 o'clock
 *   D2 User Needs      → 9 o'clock
 *
 * The action's `axes` array is in the labelled D1→D4 order from the schema;
 * we map that to the visual positions above.
 */

type ChartData = UIActionOf<"MaturityChart">["data"];
type Axis = ChartData["axes"][number];

// Schema-order → clockwise-from-12 position. axes[0]=D1 Usability ...
const POSITION_FOR_INDEX: Array<"top" | "right" | "bottom" | "left"> = [
  "top", // D1 Usability Standards
  "left", // D2 User Needs
  "bottom", // D3 Conversion
  "right", // D4 Design Execution
];

const POSITION_LABELS: Record<string, { x: number; y: number; anchor: "start" | "middle" | "end" }> = {
  top: { x: 0, y: -120, anchor: "middle" },
  right: { x: 120, y: 0, anchor: "start" },
  bottom: { x: 0, y: 120, anchor: "middle" },
  left: { x: -120, y: 0, anchor: "end" },
};

const CHART_RADIUS = 100; // SVG units; viewBox is centred at (0,0)

export function MaturityChart({ action }: { action: UIActionOf<"MaturityChart"> }) {
  const { axes, totalScore, targetScore } = action.data;

  const score = clampScore(totalScore);
  const tier = scoreTier(score);

  return (
    <CanvasCard
      label="Maturity"
      id={action.id}
      meta={`${score}/100 · ${tier}`}
    >
      <div className="grid gap-6 px-4 py-4 md:grid-cols-[1fr_1.3fr]">
        <Radar axes={axes} targetScore={targetScore} />
        <div className="space-y-3">
          <Headline score={score} tier={tier} targetScore={targetScore} />
          <AxisList axes={axes} />
        </div>
      </div>
    </CanvasCard>
  );
}

function Radar({
  axes,
  targetScore,
}: {
  axes: Axis[];
  targetScore: number | null;
}) {
  const points = axes.map((axis, i) => {
    const position = POSITION_FOR_INDEX[i] ?? "top";
    const length = (axis.normalizedScore / 10) * CHART_RADIUS;
    return positionToXY(position, length);
  });

  // Polygon path
  const pathD = points.length > 0 ? `M ${points.map((p) => `${p.x},${p.y}`).join(" L ")} Z` : "";

  // Target outline (optional) — based on a uniform target normalized to 10.
  // If targetScore is e.g. 75/100, the target on each axis is 7.5/10.
  const targetNormalized = targetScore !== null ? (targetScore / 100) * 10 : null;
  const targetPoints =
    targetNormalized !== null
      ? POSITION_FOR_INDEX.map((pos) => positionToXY(pos, (targetNormalized / 10) * CHART_RADIUS))
      : null;
  const targetPathD = targetPoints
    ? `M ${targetPoints.map((p) => `${p.x},${p.y}`).join(" L ")} Z`
    : null;

  return (
    <svg viewBox="-160 -160 320 320" role="img" aria-label="Maturity radar" className="w-full">
      {/* Background rings */}
      {[0.25, 0.5, 0.75, 1].map((r) => (
        <polygon
          key={r}
          points={[
            positionToXY("top", r * CHART_RADIUS),
            positionToXY("right", r * CHART_RADIUS),
            positionToXY("bottom", r * CHART_RADIUS),
            positionToXY("left", r * CHART_RADIUS),
          ]
            .map((p) => `${p.x},${p.y}`)
            .join(" ")}
          fill="none"
          stroke="currentColor"
          strokeOpacity={r === 1 ? 0.25 : 0.12}
          className="text-ink-muted"
        />
      ))}

      {/* Axes */}
      {(["top", "right", "bottom", "left"] as const).map((pos) => {
        const end = positionToXY(pos, CHART_RADIUS);
        return (
          <line
            key={pos}
            x1={0}
            y1={0}
            x2={end.x}
            y2={end.y}
            stroke="currentColor"
            strokeOpacity={0.18}
            className="text-ink-muted"
          />
        );
      })}

      {/* Target polygon (dashed outline) */}
      {targetPathD ? (
        <path
          d={targetPathD}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          className="text-ink-muted"
        />
      ) : null}

      {/* Score polygon (filled) */}
      <path
        d={pathD}
        fill="currentColor"
        fillOpacity={0.18}
        stroke="currentColor"
        strokeWidth={2}
        className="text-accent"
      />

      {/* Axis labels */}
      {axes.map((axis, i) => {
        const pos = POSITION_FOR_INDEX[i] ?? "top";
        const offset = POSITION_LABELS[pos]!;
        return (
          <g key={axis.label}>
            <text
              x={offset.x}
              y={offset.y - 6}
              fontSize={11}
              textAnchor={offset.anchor}
              className="fill-ink font-semibold"
            >
              {axis.label}
            </text>
            <text
              x={offset.x}
              y={offset.y + 8}
              fontSize={10}
              textAnchor={offset.anchor}
              className="fill-ink-muted font-mono"
            >
              {axis.rawScore}/{axis.maxScore}
            </text>
          </g>
        );
      })}

      {/* Centre dot */}
      <circle cx={0} cy={0} r={2.5} className="fill-ink-muted" />
    </svg>
  );
}

function Headline({
  score,
  tier,
  targetScore,
}: {
  score: number;
  tier: string;
  targetScore: number | null;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        Total maturity
      </p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-display text-4xl font-semibold leading-none text-ink">
          {score}
        </span>
        <span className="text-base text-ink-muted">/100</span>
        <span
          className={cn(
            "ml-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            tierClass(tier),
          )}
        >
          {tier}
        </span>
      </div>
      {targetScore !== null ? (
        <p className="mt-2 text-xs text-ink-muted">
          Typical post-engagement target: {targetScore}/100 (dashed outline on the radar).
        </p>
      ) : null}
    </div>
  );
}

function AxisList({ axes }: { axes: Axis[] }) {
  return (
    <ul className="space-y-2">
      {axes.map((axis) => (
        <li key={axis.label} className="rounded-lg border border-paper-edge bg-paper p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">{axis.label}</span>
            <span className="font-mono text-[10px] text-ink-muted">
              {axis.rawScore}/{axis.maxScore}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-soft">{axis.rationale}</p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Geometry + tier helpers
// ---------------------------------------------------------------------------

function positionToXY(
  pos: "top" | "right" | "bottom" | "left",
  length: number,
): { x: number; y: number } {
  switch (pos) {
    case "top":
      return { x: 0, y: -length };
    case "right":
      return { x: length, y: 0 };
    case "bottom":
      return { x: 0, y: length };
    case "left":
      return { x: -length, y: 0 };
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreTier(score: number): "Excellent" | "Strong" | "Developing" | "Weak" {
  // Aggregate tier mapping (docs/BRANDING.md → Scoring rubric calibration).
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Strong";
  if (score >= 40) return "Developing";
  return "Weak";
}

function tierClass(tier: string): string {
  switch (tier) {
    case "Excellent":
      return "border-severity-low/30 bg-severity-low/10 text-severity-low";
    case "Strong":
      return "border-lens-user-needs/30 bg-lens-user-needs/10 text-lens-user-needs";
    case "Developing":
      return "border-severity-medium/30 bg-severity-medium/10 text-severity-medium";
    case "Weak":
    default:
      return "border-severity-critical/30 bg-severity-critical/10 text-severity-critical";
  }
}
