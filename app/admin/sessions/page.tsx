import Link from "next/link";
import { listSessions, type SessionFilters } from "@/server/admin/queries";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

/**
 * /admin/sessions — filterable, paginated sessions table.
 *
 * Filters are URL-driven (`?startDate=...&terminalNode=...&page=2`) so admin
 * URLs are bookmarkable and shareable.
 */
export default async function SessionsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const filters: SessionFilters = {
    startDate: sp.startDate,
    endDate: sp.endDate,
    terminalNode: (sp.terminalNode as SessionFilters["terminalNode"]) ?? "all",
    hasUrl: (sp.hasUrl as SessionFilters["hasUrl"]) ?? "all",
    leadCaptured: (sp.leadCaptured as SessionFilters["leadCaptured"]) ?? "all",
    page: sp.page ? Math.max(1, Number(sp.page)) : 1,
    pageSize: 50,
  };

  const { rows, total, page, pageSize } = await listSessions(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-ink">Sessions</h1>
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {total} {total === 1 ? "session" : "sessions"} · page {page} / {totalPages}
          </span>
        </div>
        <p className="text-sm text-ink-soft">
          One row per visitor session — when it started, what URL (if any), terminal node, total
          Anthropic cost. For the actual first-messages visitors send, see{" "}
          <Link className="underline" href="/admin/queries">Queries</Link>.
        </p>
      </header>

      <FiltersBar filters={filters} />

      <div className="overflow-x-auto rounded-xl border border-paper-edge bg-paper">
        <table className="w-full text-sm">
          <thead className="border-b border-paper-edge bg-paper-soft/60 text-left">
            <tr>
              <Th>Start</Th>
              <Th>Duration</Th>
              <Th>Industry</Th>
              <Th>URL</Th>
              <Th>Terminal</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Lead</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-paper-edge">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-muted">
                  No sessions match these filters.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-paper-soft/40">
                  <Td>
                    <Link className="hover:underline" href={`/admin/sessions/${r.id}`}>
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </Td>
                  <Td>{formatDuration(r.startedAt, r.endedAt)}</Td>
                  <Td>{r.visitorIndustry ?? "—"}</Td>
                  <Td>
                    {r.submittedUrl ? (
                      <span className="font-mono text-xs text-ink-soft">
                        {shortenUrl(r.submittedUrl)}
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </Td>
                  <Td>
                    <TerminalChip node={r.terminalNode} />
                  </Td>
                  <Td align="right" mono>
                    ${r.totalCostUsd.toFixed(2)}
                  </Td>
                  <Td align="right">{r.leadCaptured ? "✓" : "—"}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination total={totalPages} page={page} sp={sp} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters bar
// ---------------------------------------------------------------------------

function FiltersBar({ filters }: { filters: SessionFilters }) {
  return (
    <form
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-paper-edge bg-paper p-3"
    >
      <Field label="From">
        <input
          name="startDate"
          type="date"
          defaultValue={filters.startDate ?? ""}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1 text-sm"
        />
      </Field>
      <Field label="To">
        <input
          name="endDate"
          type="date"
          defaultValue={filters.endDate ?? ""}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Terminal">
        <select
          name="terminalNode"
          defaultValue={filters.terminalNode ?? "all"}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1 text-sm"
        >
          <option value="all">All</option>
          <option value="output">Completed</option>
          <option value="cap_reached">Cap reached</option>
          <option value="abandoned">Abandoned</option>
          <option value="rate_limited">Rate limited</option>
        </select>
      </Field>
      <Field label="Has URL">
        <select
          name="hasUrl"
          defaultValue={filters.hasUrl ?? "all"}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1 text-sm"
        >
          <option value="all">All</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </Field>
      <Field label="Lead">
        <select
          name="leadCaptured"
          defaultValue={filters.leadCaptured ?? "all"}
          className="rounded-md border border-paper-edge bg-paper px-2 py-1 text-sm"
        >
          <option value="all">All</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </Field>
      <button
        type="submit"
        className="rounded-full bg-ink px-4 py-1.5 text-xs font-medium text-paper transition hover:bg-ink-soft"
      >
        Apply
      </button>
      <Link
        href="/admin/sessions"
        className="rounded-full border border-paper-edge px-4 py-1.5 text-xs text-ink-soft transition hover:border-ink-muted hover:text-ink"
      >
        Reset
      </Link>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function Pagination({
  total,
  page,
  sp,
}: {
  total: number;
  page: number;
  sp: Record<string, string | undefined>;
}) {
  if (total <= 1) return null;
  const linkFor = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== "page") qs.set(k, v);
    }
    qs.set("page", String(p));
    return `/admin/sessions?${qs.toString()}`;
  };
  return (
    <nav className="flex items-center justify-between text-xs text-ink-soft">
      <Link
        href={page > 1 ? linkFor(page - 1) : "#"}
        aria-disabled={page <= 1}
        className={cn(
          "rounded-full border border-paper-edge px-3 py-1",
          page <= 1 && "pointer-events-none opacity-40",
        )}
      >
        ← Prev
      </Link>
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {page} / {total}
      </span>
      <Link
        href={page < total ? linkFor(page + 1) : "#"}
        aria-disabled={page >= total}
        className={cn(
          "rounded-full border border-paper-edge px-3 py-1",
          page >= total && "pointer-events-none opacity-40",
        )}
      >
        Next →
      </Link>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Cells + helpers
// ---------------------------------------------------------------------------

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-4 py-2.5 text-ink",
        align === "right" && "text-right",
        mono && "font-mono text-xs",
      )}
    >
      {children}
    </td>
  );
}

function TerminalChip({ node }: { node: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    output: { label: "Completed", cls: "border-severity-low/30 bg-severity-low/10 text-severity-low" },
    cap_reached: {
      label: "Cap reached",
      cls: "border-severity-high/30 bg-severity-high/10 text-severity-high",
    },
    rate_limited: {
      label: "Rate limited",
      cls: "border-severity-medium/30 bg-severity-medium/10 text-severity-medium",
    },
    abandoned: { label: "Abandoned", cls: "border-paper-edge bg-paper-soft text-ink-muted" },
  };
  if (!node) {
    return (
      <span className="inline-flex items-center rounded-full border border-paper-edge bg-paper-soft px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
        in-flight
      </span>
    );
  }
  const m = map[node] ?? {
    label: node,
    cls: "border-paper-edge bg-paper-soft text-ink-muted",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "—";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function shortenUrl(url: string): string {
  if (url.length <= 50) return url;
  return url.slice(0, 47) + "…";
}
