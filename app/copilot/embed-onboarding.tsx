"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GravitasMark } from "@/lib/branding/mark";
import {
  readRoster,
  removeSession,
  upsertSession,
  type RosterEntry,
} from "@/lib/sessions/roster";
import { cn } from "@/lib/utils/cn";

/**
 * Onboarding view shown when the embed widget loads at /copilot?embed=1
 * with NO session id in the URL. Replaces the previous "land straight in
 * a freshly-minted blank chat" behaviour, which buried the recent-chats
 * affordance behind a dropdown most visitors never noticed.
 *
 * Flow:
 *   - Hero copy + brand mark
 *   - "Start a new chat" button → mints a uuid, registers it in the
 *     roster, navigates to /copilot?embed=1&session=<id>. The page
 *     wrapper sees the session param and renders the dual-pane shell.
 *   - "Continue a previous chat" list — each entry deep-links to the
 *     corresponding /copilot?embed=1&session=<id>.
 *
 * Sized for the compact 420×640 iframe. Comfortable margin everywhere so
 * embed.js's floating × button (top-right) never collides with content.
 */
export function EmbedOnboarding() {
  const router = useRouter();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setRoster(readRoster());
    setHydrated(true);
  }, []);

  // Click handler for "Start a new chat" — mints the id client-side so
  // every fresh start gets its own UUID, registers in the roster so it
  // shows up next time, then routes. Using router.push keeps the iframe's
  // history sensible (visitor can hit Back inside the iframe to return
  // to onboarding if they wanted to).
  const startNewChat = () => {
    const id = crypto.randomUUID();
    upsertSession(id);
    router.push(`/copilot?embed=1&session=${id}`);
  };

  const handleRemove = (id: string) => {
    removeSession(id);
    setRoster(readRoster());
  };

  return (
    <div className="flex h-screen flex-col bg-paper px-5 py-5">
      {/* Reserve a 48 px gutter on the right so embed.js's × button at
         top: 10px right: 10px doesn't collide with header content. */}
      <header className="flex items-center gap-2 pr-12">
        <GravitasMark size="sm" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Co-Pilot
        </span>
      </header>

      <section className="mt-6 space-y-3">
        <h2 className="font-display text-xl font-semibold leading-tight text-ink">
          We make Firsts. Not Followers.
        </h2>
        <p className="text-sm text-ink-soft">
          Describe a digital problem, or paste a URL. The Co-Pilot reasons across UX,
          CX, technology, and AI — and renders a tailored transformation roadmap live.
        </p>
      </section>

      <div className="mt-5">
        <button
          type="button"
          onClick={startNewChat}
          className={cn(
            "inline-flex w-full items-center justify-center gap-2 rounded-full bg-ink px-5 py-3",
            "text-sm font-medium text-paper transition hover:bg-ink-soft",
          )}
        >
          Start a new chat
          <span aria-hidden>→</span>
        </button>
      </div>

      {/* Recent chats — only rendered after hydration so we never show
         empty-list state momentarily during SSR/CSR. */}
      {hydrated && roster.length > 0 ? (
        <section className="mt-6 flex flex-1 flex-col gap-2 overflow-hidden">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Continue a chat
            </h3>
            <span className="font-mono text-[10px] text-ink-muted/70">
              {roster.length} / 10
            </span>
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-paper-edge rounded-2xl border border-paper-edge bg-paper">
            {roster.map((entry) => (
              <li key={entry.id} className="group flex items-stretch">
                <a
                  href={`/copilot?embed=1&session=${entry.id}`}
                  className="flex flex-1 flex-col gap-1 px-3 py-2.5 transition hover:bg-paper-soft/60"
                >
                  <span className="line-clamp-1 text-xs text-ink">
                    {entry.preview ?? "(no message yet)"}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                    {formatRelativeShort(entry.lastSeenAt)}
                  </span>
                </a>
                <button
                  type="button"
                  onClick={() => handleRemove(entry.id)}
                  aria-label="Remove this chat from the list"
                  className={cn(
                    "flex w-9 items-center justify-center text-base text-ink-muted/60",
                    "transition hover:bg-paper-soft hover:text-ink-soft",
                    "opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none",
                  )}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}
