"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import type { KbRun, KbNotificationSettings } from "@/server/admin/kb";

interface CadenceOption {
  label: string;
  hours: number | null;
}

/**
 * KbControls — interactive parts of /admin/kb.
 *
 *   1. Cadence picker (radio group). Persists on change (no Save button) via
 *      POST /api/admin/kb/cadence. Optimistic UI.
 *   2. Run-now buttons (Refresh / Reseed). POST /api/admin/kb/refresh. Body
 *      `{ reseed: true }` for the full re-crawl variant; gated by confirm().
 *   3. Polling progress card — when a run is active, polls
 *      /api/admin/kb/runs/current every 2s and renders a progress bar.
 *      Stops polling when status flips to completed/failed; then triggers a
 *      router refresh to repopulate the recent-runs table server-side.
 */
export function KbControls({
  initialCadenceHours,
  cadenceOptions,
  initialRun,
  initialNotifications,
}: {
  initialCadenceHours: number | null;
  cadenceOptions: CadenceOption[];
  initialRun: KbRun | null;
  initialNotifications: KbNotificationSettings;
}) {
  const [cadenceHours, setCadenceHours] = useState<number | null>(initialCadenceHours);
  const [cadenceState, setCadenceState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [activeRun, setActiveRun] = useState<KbRun | null>(initialRun);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Start/stop polling whenever there's an active run.
  useEffect(() => {
    if (!activeRun || activeRun.status !== "running") {
      stopPolling();
      return;
    }
    if (pollingRef.current) return;
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/admin/kb/runs/current", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { run: KbRun | null };
        setActiveRun(data.run);
        if (!data.run || data.run.status !== "running") {
          stopPolling();
          // Bounce a hard refresh so the SSR runs-table picks up the new row.
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }
      } catch {
        // network blip — try again next tick
      }
    }, 2000);
    return () => stopPolling();
  }, [activeRun, stopPolling]);

  async function onCadenceChange(hours: number | null) {
    const prev = cadenceHours;
    setCadenceHours(hours);
    setCadenceState("saving");
    try {
      const res = await fetch("/api/admin/kb/cadence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hours }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCadenceState("saved");
      setTimeout(() => setCadenceState("idle"), 1200);
    } catch {
      setCadenceHours(prev);
      setCadenceState("error");
    }
  }

  async function onTrigger(reseed: boolean) {
    if (activeRun && activeRun.status === "running") return;
    if (reseed && !window.confirm("Full reseed will re-crawl every whitelisted page. Continue?")) {
      return;
    }
    setTriggerError(null);
    try {
      const res = await fetch("/api/admin/kb/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reseed }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        const message = detail?.detail ?? detail?.error ?? `HTTP ${res.status}`;
        setTriggerError(message);
        return;
      }
      // The worker writes the kb_ingest_runs row asynchronously. Poll once
      // immediately to pick it up rather than wait the full 2s interval.
      const pollRes = await fetch("/api/admin/kb/runs/current", { cache: "no-store" });
      if (pollRes.ok) {
        const data = (await pollRes.json()) as { run: KbRun | null };
        setActiveRun(data.run);
      }
    } catch (err) {
      setTriggerError((err as Error).message);
    }
  }

  const inFlight = activeRun?.status === "running";
  const progressPct =
    activeRun && activeRun.pagesPlanned > 0
      ? Math.min(100, (activeRun.pagesFetched / activeRun.pagesPlanned) * 100)
      : 0;

  return (
    <section className="space-y-4 rounded-xl border border-paper-edge bg-paper p-5">
      <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
        {/* Cadence picker */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Refresh cadence
            </h2>
            {cadenceState === "saving" ? (
              <span className="font-mono text-[10px] text-ink-muted">saving…</span>
            ) : cadenceState === "saved" ? (
              <span className="font-mono text-[10px] text-severity-low">saved</span>
            ) : cadenceState === "error" ? (
              <span className="font-mono text-[10px] text-severity-critical">save failed</span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {cadenceOptions.map((opt) => {
              const checked = cadenceHours === opt.hours;
              return (
                <label
                  key={opt.label}
                  className={cn(
                    "cursor-pointer rounded-full border px-3 py-1.5 text-xs transition",
                    checked
                      ? "border-ink bg-ink text-paper"
                      : "border-paper-edge bg-paper text-ink-soft hover:border-ink-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="kb-cadence"
                    className="sr-only"
                    checked={checked}
                    onChange={() => onCadenceChange(opt.hours)}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-ink-muted">
            Cron consults this before triggering. Manual runs always work regardless.
          </p>
        </div>

        {/* Run-now buttons */}
        <div className="flex flex-wrap items-start gap-2">
          <button
            type="button"
            onClick={() => onTrigger(false)}
            disabled={inFlight}
            className={cn(
              "rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper transition hover:bg-ink-soft",
              "disabled:cursor-not-allowed disabled:bg-ink-muted/40",
            )}
          >
            {inFlight ? "Run in progress…" : "Refresh now"}
          </button>
          <button
            type="button"
            onClick={() => onTrigger(true)}
            disabled={inFlight}
            className={cn(
              "rounded-full border border-severity-high/40 px-4 py-2 text-sm font-medium text-severity-high transition hover:bg-severity-high/5",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            Full reseed
          </button>
        </div>
      </div>

      {triggerError ? (
        <div
          role="alert"
          className="rounded-lg border border-severity-critical/30 bg-severity-critical/5 px-3 py-2 text-xs text-severity-critical"
        >
          {triggerError}
        </div>
      ) : null}

      {/* In-flight progress card */}
      {activeRun && activeRun.status === "running" ? (
        <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-ink">
              {activeRun.mode === "reseed" ? "Full reseed in progress" : "Refresh in progress"}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {activeRun.pagesFetched} / {activeRun.pagesPlanned || "?"} pages ·{" "}
              {activeRun.chunksEmbedded} chunks · {activeRun.pagesErrored} errored
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-edge">
            <div
              style={{ width: `${progressPct}%` }}
              className="h-full bg-accent transition-all"
            />
          </div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Triggered by {activeRun.triggeredBy} · {Math.round(progressPct)}%
          </p>
        </div>
      ) : null}

      <NotificationsPanel initial={initialNotifications} />
    </section>
  );
}

/**
 * NotificationsPanel — recipients + success/failure toggles.
 *
 * Persists on each blur of the email field and on each toggle change. No
 * "Save" button — saved-state is shown inline next to the section heading.
 * Email validation is permissive in the UI (regex); the server-side zod is
 * the real gate.
 */
function NotificationsPanel({ initial }: { initial: KbNotificationSettings }) {
  const [emailsRaw, setEmailsRaw] = useState<string>(initial.emails.join(", "));
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(initial.notifyOnSuccess);
  const [notifyOnFailure, setNotifyOnFailure] = useState(initial.notifyOnFailure);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function persist(partial: Partial<KbNotificationSettings>) {
    setState("saving");
    try {
      const res = await fetch("/api/admin/kb/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as
          | { detail?: string; error?: string }
          | null;
        setState("error");
        setValidationError(detail?.detail ?? detail?.error ?? `HTTP ${res.status}`);
        return;
      }
      setState("saved");
      setValidationError(null);
      setTimeout(() => setState("idle"), 1200);
    } catch (err) {
      setState("error");
      setValidationError((err as Error).message);
    }
  }

  function parseEmails(raw: string): { ok: true; emails: string[] } | { ok: false; bad: string } {
    const parts = raw
      .split(/[,\n;]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    for (const p of parts) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)) {
        return { ok: false, bad: p };
      }
    }
    return { ok: true, emails: parts };
  }

  function onEmailsBlur() {
    const parsed = parseEmails(emailsRaw);
    if (!parsed.ok) {
      setValidationError(`Not an email: ${parsed.bad}`);
      setState("error");
      return;
    }
    // Normalise the textarea to the de-duped, lowercased canonical form.
    setEmailsRaw(parsed.emails.join(", "));
    void persist({ emails: parsed.emails });
  }

  function onToggle(field: "notifyOnSuccess" | "notifyOnFailure") {
    if (field === "notifyOnSuccess") {
      const next = !notifyOnSuccess;
      setNotifyOnSuccess(next);
      void persist({ notifyOnSuccess: next });
    } else {
      const next = !notifyOnFailure;
      setNotifyOnFailure(next);
      void persist({ notifyOnFailure: next });
    }
  }

  return (
    <section className="space-y-3 border-t border-paper-edge pt-5">
      <div className="flex items-center gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Notifications
        </h2>
        {state === "saving" ? (
          <span className="font-mono text-[10px] text-ink-muted">saving…</span>
        ) : state === "saved" ? (
          <span className="font-mono text-[10px] text-severity-low">saved</span>
        ) : state === "error" ? (
          <span className="font-mono text-[10px] text-severity-critical">save failed</span>
        ) : null}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="kb-notify-emails"
          className="block text-xs text-ink-soft"
        >
          Send a summary to these addresses after each ingest run (comma- or newline-separated):
        </label>
        <textarea
          id="kb-notify-emails"
          rows={2}
          value={emailsRaw}
          onChange={(e) => setEmailsRaw(e.target.value)}
          onBlur={onEmailsBlur}
          placeholder="ops@thisisgravitas.com, kieran@thisisgravitas.com"
          className={cn(
            "w-full rounded-lg border border-paper-edge bg-paper px-3 py-2 text-sm text-ink",
            "placeholder:text-ink-muted focus:border-ink-muted focus:outline-none",
            "font-mono text-xs",
          )}
        />
        {validationError ? (
          <p className="text-xs text-severity-critical">{validationError}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleChip
          label="Notify on success"
          checked={notifyOnSuccess}
          tone="ok"
          onChange={() => onToggle("notifyOnSuccess")}
        />
        <ToggleChip
          label="Notify on failure"
          checked={notifyOnFailure}
          tone="warn"
          onChange={() => onToggle("notifyOnFailure")}
        />
      </div>

      <p className="text-[11px] text-ink-muted">
        Emails are sent from <code className="font-mono">SMTP_USER</code> (set in{" "}
        <code className="font-mono">.env.local</code>). If SMTP isn&apos;t configured the
        worker logs a warning and skips the send — settings are still persisted.
      </p>
    </section>
  );
}

function ToggleChip({
  label,
  checked,
  tone,
  onChange,
}: {
  label: string;
  checked: boolean;
  tone: "ok" | "warn";
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition",
        checked
          ? tone === "ok"
            ? "border-severity-low bg-severity-low/10 text-severity-low"
            : "border-severity-high bg-severity-high/10 text-severity-high"
          : "border-paper-edge bg-paper text-ink-muted hover:border-ink-muted",
      )}
    >
      <span
        className={cn(
          "inline-block h-2.5 w-2.5 rounded-full transition",
          checked
            ? tone === "ok"
              ? "bg-severity-low"
              : "bg-severity-high"
            : "bg-ink-muted/30",
        )}
      />
      {label}
    </button>
  );
}
