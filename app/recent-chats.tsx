"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readRoster, removeSession, type RosterEntry } from "@/lib/sessions/roster";

/**
 * Landing-page "Recent chats" panel.
 *
 * Renders the localStorage roster (up to 10 entries, newest first). Each row
 * deep-links into /copilot?session=<id> so the visitor can resume that exact
 * conversation; the chat shell reads the query param and seeds messages from
 * /api/chat/history.
 *
 * Renders nothing on the server (the roster only exists client-side) and
 * renders nothing for a first-time visitor — the landing page stays clean
 * until there's something worth showing.
 *
 * Per-row "×" button removes the entry from the roster only — the server-
 * side messages stay in Supabase. (We don't expose visitor-driven deletes
 * yet; that's a Phase 2 retention story.)
 */
export function RecentChats() {
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setEntries(readRoster());
    setHydrated(true);
  }, []);

  const handleRemove = useCallback((id: string) => {
    removeSession(id);
    setEntries(readRoster());
  }, []);

  if (!hydrated) return null; // avoid SSR/CSR mismatch on first paint
  if (entries.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Recent chats
        </h2>
        <span className="font-mono text-[10px] text-ink-muted/70">
          {entries.length} / 10
        </span>
      </div>

      <ul className="divide-y divide-paper-edge overflow-hidden rounded-2xl border border-paper-edge bg-paper">
        {entries.map((entry) => (
          <li key={entry.id} className="group flex items-stretch">
            <Link
              href={`/copilot?session=${entry.id}`}
              className="flex flex-1 flex-col gap-1 px-4 py-3 transition hover:bg-paper-soft/50"
            >
              <span className="line-clamp-1 text-sm text-ink">
                {entry.preview ?? "(no message yet)"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {formatRelative(entry.lastSeenAt)}
              </span>
            </Link>
            <button
              type="button"
              onClick={() => handleRemove(entry.id)}
              aria-label="Remove this chat from the list"
              className={cnRemove}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const cnRemove =
  "flex w-10 items-center justify-center text-base text-ink-muted/60 " +
  "transition hover:bg-paper-soft hover:text-ink-soft opacity-0 group-hover:opacity-100 " +
  "focus:opacity-100 focus:outline-none focus:bg-paper-soft";

/**
 * "2 minutes ago" / "3 days ago" — kept dependency-free to avoid pulling
 * date-fns. Falls back to a locale date once we get past a week.
 */
function formatRelative(ts: number): string {
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
