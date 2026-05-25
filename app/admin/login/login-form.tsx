"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser";

type State =
  | { kind: "idle"; error: string | null }
  | { kind: "submitting" }
  | { kind: "sent" };

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ kind: "idle", error: null });

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-xl border border-paper-edge bg-paper-soft px-4 py-3 text-sm text-ink-soft">
        Supabase isn&apos;t configured in this environment. Set{" "}
        <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span> +{" "}
        <span className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> to enable admin sign-in.
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.kind === "submitting") return;
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setState({ kind: "idle", error: "That doesn't look like an email." });
      return;
    }
    setState({ kind: "submitting" });
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setState({ kind: "idle", error: "Supabase client unavailable." });
      return;
    }
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        // Magic link returns to /admin/auth/callback with `?next=/admin/...`
        emailRedirectTo: `${origin}/admin/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      setState({ kind: "idle", error: error.message });
      return;
    }
    setState({ kind: "sent" });
  }

  if (state.kind === "sent") {
    return (
      <div className="rounded-xl border border-lens-user-needs/30 bg-lens-user-needs/5 px-4 py-3 text-sm text-ink">
        <p className="font-semibold">Check your inbox.</p>
        <p className="mt-1 text-ink-soft">
          We&apos;ve emailed a sign-in link to <span className="font-mono">{email}</span>. The link expires in an hour.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label
        htmlFor="admin-email"
        className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted"
      >
        Email
      </label>
      <input
        id="admin-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@thisisgravitas.com"
        disabled={state.kind === "submitting"}
        className={cn(
          "w-full rounded-full border border-paper-edge bg-paper px-4 py-2.5 text-sm text-ink",
          "placeholder:text-ink-muted focus:border-ink-muted focus:outline-none",
          "disabled:bg-paper-soft disabled:text-ink-muted",
        )}
      />
      <button
        type="submit"
        disabled={state.kind === "submitting" || email.trim().length === 0}
        className={cn(
          "w-full rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-paper",
          "transition hover:bg-ink-soft",
          "disabled:cursor-not-allowed disabled:bg-ink-muted/40 disabled:text-paper/80",
        )}
      >
        {state.kind === "submitting" ? "Sending…" : "Email me a sign-in link"}
      </button>
      {state.kind === "idle" && state.error ? (
        <p role="alert" className="text-xs text-severity-critical">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
