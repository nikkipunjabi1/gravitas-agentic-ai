import Link from "next/link";
import { CopilotShell } from "./copilot-shell";
import { EmbedOnboarding } from "./embed-onboarding";
import { GravitasMark } from "@/lib/branding/mark";
import { getUiDisclaimer } from "@/server/runtime-config";

/**
 * /copilot — the dual-pane experience.
 *
 * Two render modes:
 *
 *   - full      (default, `/copilot`)                — header + footer chrome
 *   - embed     (`/copilot?embed=1`)                 — no chrome; designed for
 *                                                     embedding in a parent
 *                                                     site as a chat widget
 *                                                     via public/embed.js.
 *
 * The embed mode is what the floating chat button on thisisgravitas.com
 * loads as the iframe source. Removing the header/footer + Back link keeps
 * the iframe content clean.
 */
// Force dynamic so searchParams.session always re-renders the page with the
// fresh value when the URL changes. Without this, Next's static optimisation
// can serve a cached HTML/RSC payload with a stale `requestedSessionId`,
// stranding the client component on the wrong chat.
export const dynamic = "force-dynamic";

export default async function CopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ embed?: string; session?: string }>;
}) {
  const params = await searchParams;
  const isEmbed = params.embed === "1" || params.embed === "true";
  // Validate at the server boundary — a malformed id never reaches the client
  // shell. The shell mints a fresh id when this is null.
  const requestedSessionId =
    typeof params.session === "string" && isUuidV4(params.session)
      ? params.session
      : null;
  // Visitor-visible AI disclaimer (P1.19) — admin-editable via
  // /admin/settings → Branding. Empty saved value falls back to the
  // DEFAULT_UI_DISCLAIMER constant in runtime-config.ts.
  const disclaimer = await getUiDisclaimer();

  if (isEmbed) {
    // Embed onboarding screen — shown on first iframe load (no session id
    // in URL). Surfaces "Start a new chat" + recent-chats list, so the
    // visitor isn't dropped into a blank chat with no way to find prior
    // conversations. Once they pick a chat (or start a new one), the URL
    // gets `?session=<id>` and we render the dual-pane shell instead.
    if (!requestedSessionId) {
      return (
        <main className="flex min-h-screen flex-col bg-paper text-ink">
          <EmbedOnboarding />
        </main>
      );
    }
    return (
      <main className="flex min-h-screen flex-col bg-paper text-ink">
        <CopilotShell
          embed
          requestedSessionId={requestedSessionId}
          disclaimer={disclaimer}
        />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-paper text-ink">
      <header className="flex items-center justify-between border-b border-paper-edge bg-paper/80 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <GravitasMark size="md" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Transformation Co-Pilot
          </span>
        </div>
        <Link
          href="/"
          className="rounded-full border border-paper-edge px-3 py-1 text-xs text-ink-soft transition hover:border-ink-muted hover:text-ink"
        >
          Back
        </Link>
      </header>

      <CopilotShell
        requestedSessionId={requestedSessionId}
        disclaimer={disclaimer}
      />

      <footer className="space-y-0.5 border-t border-paper-edge px-5 py-2 text-[11px] text-ink-muted">
        <p>Conversations are logged for quality and to improve recommendations.</p>
        <p className="italic">{disclaimer}</p>
      </footer>
    </main>
  );
}

function isUuidV4(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
