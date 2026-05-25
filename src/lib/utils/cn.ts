import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tiny class-merging helper used across UI components.
 * Combines `clsx` (conditional class lists) with `tailwind-merge`
 * (dedupes conflicting Tailwind utilities — last one wins).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
