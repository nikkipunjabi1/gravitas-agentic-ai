"use client";

import { CanvasCard } from "./_shell";
import { cn } from "@/lib/utils/cn";
import type { UIActionOf } from "@/canvas/schema";

/**
 * <ContactCard> — P1.18 reference component.
 *
 * Renders a callable contact block (name + role + email + phone) inside
 * the canvas. Designed to do double duty:
 *
 *   1. As a real visitor-facing surface — Discovery / Output emits it
 *      when the visitor explicitly asks "how do I reach you?" or as the
 *      closing flourish on a finished audit.
 *   2. As the canonical "how to plug in a new component" example —
 *      every piece you'd need to wire (schema branch, registry entry,
 *      agent emit-site) is documented in /docs/UI_CONTRACT.md and
 *      mirrored here.
 *
 * Component contract (per UI_CONTRACT.md):
 *   - Renders from `action.data` alone.
 *   - No fetching, no global state, no Date.now(), no randomness.
 *   - Tailwind theme classes only.
 *   - canvasEnter animation via the <CanvasCard> shell.
 */
export function ContactCard({ action }: { action: UIActionOf<"ContactCard"> }) {
  const { name, role, email, phone, headline, body } = action.data;
  return (
    <CanvasCard label="Get in touch" id={action.id} tone="accent">
      <div className="space-y-4 px-4 py-4">
        {headline ? (
          <p className="text-sm font-medium text-ink">{headline}</p>
        ) : null}

        <div className="rounded-xl border border-paper-edge bg-paper p-4">
          <p className="font-display text-base font-semibold leading-tight text-ink">
            {name}
          </p>
          {role ? (
            <p className="mt-0.5 text-xs text-ink-soft">{role}</p>
          ) : null}

          <ul className="mt-3 space-y-1.5">
            {email ? (
              <ContactRow
                icon={<MailIcon />}
                label="Email"
                value={email}
                href={`mailto:${email}`}
              />
            ) : null}
            {phone ? (
              <ContactRow
                icon={<PhoneIcon />}
                label="Phone"
                value={phone}
                href={`tel:${phone.replace(/[^+\d]/g, "")}`}
              />
            ) : null}
          </ul>
        </div>

        {body ? (
          <p className="text-xs leading-relaxed text-ink-soft">{body}</p>
        ) : null}
      </div>
    </CanvasCard>
  );
}

function ContactRow({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <li>
      <a
        href={href}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-ink",
          "transition hover:bg-paper-soft",
        )}
      >
        <span className="text-ink-muted">{icon}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {label}
        </span>
        <span className="ml-auto truncate font-medium">{value}</span>
      </a>
    </li>
  );
}

function MailIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l9 6 9-6M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h2.5a1 1 0 011 .76l1 4a1 1 0 01-.27.95L7.6 10.2a11 11 0 005.2 5.2l1.49-1.63a1 1 0 01.95-.27l4 1a1 1 0 01.76 1V19a2 2 0 01-2 2A16 16 0 013 5z" />
    </svg>
  );
}
