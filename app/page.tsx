import Link from "next/link";
import { RecentChats } from "./recent-chats";

/**
 * Public landing — a thin holding page that points visitors at the Co-Pilot.
 *
 * The dual-pane experience lives at /copilot. Marketing content for
 * thisisgravitas.com is out of scope for this project; we ship the
 * agent surface only.
 *
 * "Start a new chat" always mints a fresh session id (the chat shell handles
 * that on mount when no `?session=` query param is present). The optional
 * "Recent chats" list — rendered only when the visitor's localStorage roster
 * has entries — deep-links into /copilot?session=<id> to resume a specific
 * prior conversation.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-10 px-6 py-16">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">
          Gravitas — Transformation Co-Pilot
        </p>
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
          We make Firsts. Not Followers.
        </h1>
        <p className="max-w-2xl text-lg text-ink-soft">
          Describe a digital problem. The Co-Pilot reasons across UX, CX, technology and
          AI — and renders a tailored transformation roadmap live, on a Generative Canvas.
        </p>
      </header>

      <div>
        <Link
          href="/copilot"
          className="inline-flex items-center gap-2 rounded-full bg-ink px-6 py-3 font-medium text-paper transition hover:bg-ink-soft"
        >
          Start a new chat
          <span aria-hidden>→</span>
        </Link>
      </div>

      <RecentChats />

      <footer className="mt-4 border-t border-paper-edge pt-6 text-sm text-ink-muted">
        <p>
          Conversations are logged for quality and to improve recommendations.
        </p>
      </footer>
    </main>
  );
}
