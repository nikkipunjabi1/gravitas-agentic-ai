"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils/cn";
import type { SettingRow, SettingKey } from "@/server/settings";

/**
 * Editable form for the runtime settings. Each row is its own card so the
 * admin can see exactly which knob they're changing, with its description
 * + last-touched audit metadata. Saves are individual (one button per row)
 * to keep failure blast radius small.
 */
export function SettingsForm({ settings }: { settings: SettingRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    Record<string, { tone: "ok" | "err"; message: string } | null>
  >({});
  const [resetState, setResetState] = useState<{
    tone: "ok" | "err";
    message: string;
  } | null>(null);

  const handleSave = async (key: SettingKey, value: number) => {
    setStatus((s) => ({ ...s, [key]: null }));
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      setStatus((s) => ({ ...s, [key]: { tone: "ok", message: "Saved." } }));
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus((s) => ({
        ...s,
        [key]: { tone: "err", message: (err as Error).message },
      }));
    }
  };

  const handleResetQuota = async () => {
    setResetState(null);
    try {
      const res = await fetch("/api/admin/quota/reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { deleted: number };
      setResetState({
        tone: "ok",
        message: `Cleared today's quota — ${body.deleted} row${body.deleted === 1 ? "" : "s"} removed. Visitors get a clean slate for the rest of the UTC day.`,
      });
    } catch (err) {
      setResetState({ tone: "err", message: (err as Error).message });
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Rate limits
        </h2>
        <ul className="space-y-3">
          {settings.map((row) => (
            <li key={row.key}>
              <SettingRowCard
                row={row}
                status={status[row.key] ?? null}
                onSave={(value) => handleSave(row.key, value)}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Demo helpers
        </h2>
        <div className="rounded-xl border border-paper-edge bg-paper p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-ink">Reset today&apos;s IP quota</h3>
              <p className="text-xs text-ink-soft">
                Clears every visitor&apos;s turn + audit counters for the current UTC day,
                across all IP hashes. Use this to unblock a demo that hit a cap — the
                cap itself isn&apos;t changed.
              </p>
            </div>
            <button
              type="button"
              onClick={handleResetQuota}
              disabled={isPending}
              className={cn(
                "shrink-0 rounded-full bg-ink px-4 py-2 text-xs font-medium text-paper",
                "transition hover:bg-ink-soft",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              Reset now
            </button>
          </div>
          {resetState ? (
            <p
              className={cn(
                "mt-3 text-xs",
                resetState.tone === "ok" ? "text-ink-soft" : "text-severity-critical",
              )}
            >
              {resetState.message}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SettingRowCard({
  row,
  status,
  onSave,
}: {
  row: SettingRow;
  status: { tone: "ok" | "err"; message: string } | null;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>(String(row.value));
  const draftNum = Number(draft);
  const isValid = Number.isFinite(draftNum) && Number.isInteger(draftNum) && draftNum >= 0;
  const isDirty = isValid && draftNum !== row.value;

  return (
    <div className="rounded-xl border border-paper-edge bg-paper p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-ink">{row.key}</code>
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              current: {row.value}
            </span>
          </div>
          {row.description ? (
            <p className="text-xs text-ink-soft">{row.description}</p>
          ) : null}
          {row.updatedAt && row.updatedAt !== new Date(0).toISOString() ? (
            <p className="font-mono text-[10px] text-ink-muted/80">
              Last changed {formatLocal(row.updatedAt)}
              {row.updatedBy ? ` by ${row.updatedBy}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={cn(
              "w-24 rounded-md border bg-paper-soft/60 px-2 py-1.5 text-right font-mono text-sm",
              isValid ? "border-paper-edge text-ink" : "border-severity-critical/60 text-severity-critical",
            )}
          />
          <button
            type="button"
            onClick={() => onSave(draftNum)}
            disabled={!isDirty}
            className={cn(
              "rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper",
              "transition hover:bg-ink-soft",
              "disabled:cursor-not-allowed disabled:bg-ink-muted/40",
            )}
          >
            Save
          </button>
        </div>
      </div>
      {status ? (
        <p
          className={cn(
            "mt-2 text-xs",
            status.tone === "ok" ? "text-ink-soft" : "text-severity-critical",
          )}
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

function formatLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
