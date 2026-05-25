/**
 * Client-side Co-Pilot session roster.
 *
 * Keeps the visitor's last N Co-Pilot session ids in localStorage so they can
 * (a) jump back into any prior chat from the landing page, and (b) deep-link
 * to a specific chat via /copilot?session=<id>. The browser is the only
 * client-facing "auth" we have for anonymous visitors — owning the id IS
 * the right to read its messages.
 *
 * Storage shape (key: `gravitas.copilot.roster.v1`):
 *   {
 *     entries: [
 *       { id, createdAt, lastSeenAt, preview }
 *       ...
 *     ]
 *   }
 *
 * Capacity: MAX_ENTRIES (10). On overflow, the oldest entry by `lastSeenAt`
 * is evicted — never the most recently used.
 *
 * Per-entry TTL (ENTRY_TTL_MS, 30 days): entries older than this are filtered
 * out on read. We deliberately make TTL longer than the legacy single-session
 * 7-day window so the roster doesn't surprise visitors who left a chat open
 * across a quiet stretch.
 *
 * SSR-safe: every function returns the empty-roster value when `window` is
 * unavailable, so server components can import this without crashing.
 */

export interface RosterEntry {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** First user message, truncated. Used as the chat label. */
  preview: string | null;
}

const STORAGE_KEY = "gravitas.copilot.roster.v1";
const MAX_ENTRIES = 10;
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PREVIEW_MAX_CHARS = 80;

interface StoredShape {
  entries?: unknown;
}

/**
 * Read the roster, drop expired entries, return newest-first.
 *
 * Self-healing: malformed JSON, non-array entries, missing fields are all
 * silently filtered. We never throw from a read — a wedged roster should
 * degrade to "no recent chats" rather than break the landing page.
 */
export function readRoster(): RosterEntry[] {
  if (typeof window === "undefined") return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: StoredShape;
  try {
    parsed = JSON.parse(raw) as StoredShape;
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.entries)) return [];

  const now = Date.now();
  const clean: RosterEntry[] = [];
  for (const item of parsed.entries) {
    const entry = sanitiseEntry(item);
    if (!entry) continue;
    if (now - entry.lastSeenAt > ENTRY_TTL_MS) continue;
    clean.push(entry);
  }
  clean.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return clean.slice(0, MAX_ENTRIES);
}

/**
 * Insert a new session at the top of the roster, or bump an existing one's
 * `lastSeenAt` + optionally patch its preview. Evicts the oldest entry when
 * the roster exceeds MAX_ENTRIES.
 *
 * Returns the updated entry so callers can chain off it (e.g. read back the
 * preview that just got committed).
 */
export function upsertSession(
  id: string,
  patch: { preview?: string | null } = {},
): RosterEntry | null {
  if (typeof window === "undefined") return null;
  if (!isUuid(id)) return null;
  const now = Date.now();
  const current = readRoster();
  const existingIdx = current.findIndex((e) => e.id === id);

  let updated: RosterEntry;
  if (existingIdx >= 0) {
    const prev = current[existingIdx]!;
    updated = {
      id: prev.id,
      createdAt: prev.createdAt,
      lastSeenAt: now,
      preview:
        patch.preview !== undefined ? truncatePreview(patch.preview) : prev.preview,
    };
    current.splice(existingIdx, 1);
  } else {
    updated = {
      id,
      createdAt: now,
      lastSeenAt: now,
      preview: truncatePreview(patch.preview ?? null),
    };
  }

  const next = [updated, ...current].slice(0, MAX_ENTRIES);
  writeRoster(next);
  return updated;
}

/**
 * Remove a single entry by id. No-op if the id isn't present. Used by the
 * landing-page UI's per-chat "remove" affordance.
 */
export function removeSession(id: string): void {
  if (typeof window === "undefined") return;
  const current = readRoster();
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) return;
  writeRoster(next);
}

/** Drop every entry. Used by a "clear all" admin affordance (not wired yet). */
export function clearRoster(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore quota / private-mode errors.
  }
}

/** Read a single entry by id, or null when absent. */
export function getRosterEntry(id: string): RosterEntry | null {
  if (!isUuid(id)) return null;
  return readRoster().find((e) => e.id === id) ?? null;
}

/**
 * Truncate a candidate preview to PREVIEW_MAX_CHARS. We strip whitespace
 * extremes + replace runs of internal whitespace with a single space so the
 * preview reads as one line in the landing-page list.
 */
function truncatePreview(value: string | null): string | null {
  if (value == null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed;
  return collapsed.slice(0, PREVIEW_MAX_CHARS - 1) + "…";
}

function sanitiseEntry(item: unknown): RosterEntry | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" || !isUuid(obj.id)) return null;
  if (typeof obj.createdAt !== "number") return null;
  if (typeof obj.lastSeenAt !== "number") return null;
  const preview =
    typeof obj.preview === "string" ? obj.preview : obj.preview === null ? null : null;
  return {
    id: obj.id,
    createdAt: obj.createdAt,
    lastSeenAt: obj.lastSeenAt,
    preview,
  };
}

function writeRoster(entries: RosterEntry[]): void {
  try {
    const payload: StoredShape = { entries };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private-mode — silently degrade. The in-flight session still
    // works for this tab; the resume affordance just won't surface later.
  }
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Test hook — vitest exercises eviction + TTL behaviour through the public
// API; this barrel is kept narrow on purpose.
export const _internal = { MAX_ENTRIES, ENTRY_TTL_MS, PREVIEW_MAX_CHARS };
