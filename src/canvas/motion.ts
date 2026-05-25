import type { Variants } from "framer-motion";

/**
 * Shared mount animation for canvas components. Consistency over expressiveness
 * (UI_CONTRACT.md rule 5). Every component composes this variant so the canvas
 * feels like one surface, not a grab-bag of motions.
 */
export const canvasEnter: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.32,
      ease: [0.2, 0.8, 0.2, 1],
    },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};
