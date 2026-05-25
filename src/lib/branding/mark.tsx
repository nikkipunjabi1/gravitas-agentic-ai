import { GRAVITAS_LOGO_DATA_URI } from "./logo";
import { cn } from "@/lib/utils/cn";

/**
 * <GravitasMark> — shared logo display.
 *
 * The wordmark SVG we ship has its paths filled in ink (#1A1A1A), so it
 * renders cleanly on any light/paper background out of the box. By default
 * we render it BARE (no wrapper) — the wordmark stands on its own.
 *
 * For dark surfaces (canvas accent cards, future dark-mode admin), pass
 * `onDark` to invert the wordmark to white via a CSS filter. No second
 * SVG asset to maintain; one source-of-truth file.
 */
export function GravitasMark({
  size = "sm",
  onDark = false,
  className,
}: {
  size?: "xs" | "sm" | "md" | "lg";
  /** Invert the wordmark to white for dark surfaces. */
  onDark?: boolean;
  className?: string;
}) {
  const height = {
    xs: "h-2.5",
    sm: "h-3.5",
    md: "h-4",
    lg: "h-5",
  }[size];

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={GRAVITAS_LOGO_DATA_URI}
      alt="Gravitas"
      className={cn(
        "w-auto",
        height,
        onDark && "[filter:invert(1)_brightness(2)]",
        className,
      )}
    />
  );
}
