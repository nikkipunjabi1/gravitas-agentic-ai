import type { Config } from "tailwindcss";

/**
 * Gravitas design tokens.
 *
 * Phase 0 placeholder — the official Gravitas brand guide will replace these
 * once we have it. See docs/BRANDING.md → Colour, typography, spacing.
 *
 * Rule: every component reads from these tokens via Tailwind classes.
 * No ad-hoc hex values in component files.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Gravitas voice is confident and grounded — dark surface, warm accent.
        // Replace with real brand values when the guide lands.
        ink: {
          DEFAULT: "#0B0B0F",   // primary text on light, surface on dark
          soft: "#2A2A33",
          muted: "#6B6B75",
        },
        paper: {
          DEFAULT: "#FAFAF7",   // primary light surface
          soft: "#F2F2EC",
          edge: "#E5E5DC",
        },
        accent: {
          DEFAULT: "#E94E1B",   // warm orange placeholder
          soft: "#F7B79A",
        },
        lens: {
          // One swatch per Four-Lens dimension (see docs/BRANDING.md)
          usability: "#3F5BCC",       // D1
          "user-needs": "#2E8B6B",    // D2
          conversion: "#E94E1B",      // D3 (accent)
          "design-execution": "#7A4DBC", // D4
        },
        severity: {
          critical: "#B91C1C",
          high: "#D97706",
          medium: "#CA8A04",
          low: "#65A30D",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      animation: {
        "canvas-enter": "canvasEnter 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "pulse-soft": "pulseSoft 2.4s ease-in-out infinite",
        // Three-dot thinking indicator. Each dot fires the same `bounceDot`
        // keyframe with a staggered delay so they rise + fall in sequence.
        "bounce-dot-1": "bounceDot 1.2s ease-in-out 0s infinite",
        "bounce-dot-2": "bounceDot 1.2s ease-in-out 0.18s infinite",
        "bounce-dot-3": "bounceDot 1.2s ease-in-out 0.36s infinite",
      },
      keyframes: {
        canvasEnter: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "0.8" },
          "50%": { opacity: "1" },
        },
        bounceDot: {
          "0%, 70%, 100%": { opacity: "0.35", transform: "translateY(0)" },
          "35%": { opacity: "1", transform: "translateY(-3px)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
