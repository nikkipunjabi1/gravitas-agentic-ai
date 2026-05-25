"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import type { UIActionOf } from "@/canvas/schema";
import { CanvasCard } from "./_shell";

/**
 * DailyCapReached — Phase 1 canvas component.
 *
 * Global $50/day Anthropic spend cap was hit. We capture an email into the
 * waitlist (Phase 1) so we can email "we're back" the next day (Phase 2).
 *
 * Form posts to /api/waitlist. Three states:
 *   "idle"      — show form
 *   "submitting" — disabled button, no spinner spam
 *   "success"   — replace form with thank-you message
 *   "error"     — show inline error, keep form, allow retry
 */

type State =
  | { kind: "idle"; error: string | null }
  | { kind: "submitting" }
  | { kind: "success" };

export function DailyCapReached({
  action,
}: {
  action: UIActionOf<"DailyCapReached">;
}) {
  const { headline, body, emailFieldLabel, submitLabel, sessionId, intendedUrl } =
    action.data;
  const [state, setState] = useState<State>({ kind: "idle", error: null });
  const [email, setEmail] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === "submitting") return;
    const trimmed = email.trim();
    if (!isPlausibleEmail(trimmed)) {
      setState({ kind: "idle", error: "That doesn't look like an email address." });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          sessionId,
          intendedUrl,
          source: "daily_cap",
        }),
      });
      if (!res.ok) {
        const detail = await safeJson(res);
        const message =
          (detail && typeof detail === "object" && "error" in detail
            ? String((detail as { error?: unknown }).error ?? "")
            : "") || `request failed (${res.status})`;
        setState({ kind: "idle", error: message });
        return;
      }
      setState({ kind: "success" });
    } catch (err) {
      setState({
        kind: "idle",
        error: err instanceof Error ? err.message : "submit failed",
      });
    }
  }

  return (
    <CanvasCard
      label="Daily cap reached"
      id={action.id}
      meta="waitlist"
      tone="warning"
    >
      <div className="space-y-4 px-4 py-4">
        <h3 className="font-display text-base font-semibold leading-snug text-ink">
          {headline}
        </h3>
        <p className="text-sm leading-relaxed text-ink-soft">{body}</p>

        {state.kind === "success" ? (
          <SuccessState />
        ) : (
          <form onSubmit={onSubmit} className="space-y-2">
            <label
              htmlFor={`cap-email-${action.id}`}
              className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted"
            >
              {emailFieldLabel}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={`cap-email-${action.id}`}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state.kind === "submitting"}
                className={cn(
                  "flex-1 rounded-full border border-paper-edge bg-paper px-4 py-2 text-sm text-ink",
                  "placeholder:text-ink-muted focus:border-ink-muted focus:outline-none",
                  "disabled:bg-paper-soft disabled:text-ink-muted",
                )}
              />
              <button
                type="submit"
                disabled={state.kind === "submitting" || email.trim().length === 0}
                className={cn(
                  "shrink-0 rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper",
                  "transition hover:bg-ink-soft",
                  "disabled:cursor-not-allowed disabled:bg-ink-muted/40 disabled:text-paper/80",
                )}
              >
                {state.kind === "submitting" ? "Saving…" : submitLabel}
              </button>
            </div>
            {state.kind === "idle" && state.error ? (
              <p className="text-xs text-severity-critical" role="alert">
                {state.error}
              </p>
            ) : null}
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              No marketing — one note when the next day&apos;s budget resets.
            </p>
          </form>
        )}
      </div>
    </CanvasCard>
  );
}

function SuccessState() {
  return (
    <div className="rounded-xl border border-lens-user-needs/30 bg-lens-user-needs/5 px-4 py-3">
      <p className="text-sm font-semibold text-ink">Shukran! / شكراً</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        Got it. We&apos;ll let you know the moment the next day&apos;s budget is available so we can pick this up.
      </p>
    </div>
  );
}

function isPlausibleEmail(value: string): boolean {
  // Intentionally permissive — server-side validation in /api/waitlist is
  // the actual gate. This just catches obvious typos before we submit.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
