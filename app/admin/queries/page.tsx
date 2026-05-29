import Link from "next/link";
import { listRecentOpenersPaged } from "@/server/admin/queries";
import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * /admin/queries — paginated list of session opener messages.
 *
 * URL-driven `?page=N` pagination so admin links are bookmarkable and the
 * Back button works naturally. Default page size 25 — small enough to scan
 * on one screen, large enough that you don't paginate constantly.
 */
export default async function QueriesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, sp.page ? Number(sp.page) : 1);
  const { rows, total } = await listRecentOpenersPaged(page, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-ink">Visitor queries</h1>
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {total} {total === 1 ? "session" : "sessions"} · page {page} / {totalPages}
          </span>
        </div>
        <p className="text-sm text-ink-soft">
          The opening message of each session — what visitors actually type when they arrive.
          Click any row to open the full session. For session-level metrics, see{" "}
          <Link className="underline" href="/admin/sessions">Sessions</Link>.
        </p>
      </header>

      <ul className="space-y-1.5 rounded-xl border border-paper-edge bg-paper">
        {rows.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-ink-muted">
            No visitor messages yet.
          </li>
        ) : (
          rows.map((q) => (
            <li key={q.sessionId}>
              <Link
                href={`/admin/sessions/${q.sessionId}`}
                className="block px-4 py-3 transition hover:bg-paper-soft/60"
              >
                <p className="text-sm text-ink">{q.content}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  {new Date(q.ts).toLocaleString()}
                </p>
              </Link>
            </li>
          ))
        )}
      </ul>

      <Pagination page={page} totalPages={totalPages} />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="flex items-center justify-between text-xs text-ink-soft">
      <Link
        href={page > 1 ? `/admin/queries?page=${page - 1}` : "#"}
        aria-disabled={page <= 1}
        className={cn(
          "rounded-full border border-paper-edge px-3 py-1",
          page <= 1 && "pointer-events-none opacity-40",
        )}
      >
        ← Prev
      </Link>
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {page} / {totalPages}
      </span>
      <Link
        href={page < totalPages ? `/admin/queries?page=${page + 1}` : "#"}
        aria-disabled={page >= totalPages}
        className={cn(
          "rounded-full border border-paper-edge px-3 py-1",
          page >= totalPages && "pointer-events-none opacity-40",
        )}
      >
        Next →
      </Link>
    </nav>
  );
}
