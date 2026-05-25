import Link from "next/link";
import { listRecentOpeners } from "@/server/admin/queries";

export const dynamic = "force-dynamic";

/**
 * /admin/queries — recent visitor opener messages.
 *
 * Phase 1: a flat list of the latest 100 first-messages. Phase 2 adds topic
 * clustering (Ollama nightly job) + search.
 */
export default async function QueriesPage() {
  const queries = await listRecentOpeners(100);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-ink">Visitor queries</h1>
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {queries.length} {queries.length === 1 ? "query" : "queries"}
          </span>
        </div>
        <p className="text-sm text-ink-soft">
          The opening message of each session — what visitors actually type when they arrive.
          Click any row to open the full session. For session-level metrics, see{" "}
          <Link className="underline" href="/admin/sessions">Sessions</Link>.
        </p>
      </header>

      <ul className="space-y-1.5 rounded-xl border border-paper-edge bg-paper">
        {queries.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-ink-muted">
            No visitor messages yet.
          </li>
        ) : (
          queries.map((q) => (
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
    </div>
  );
}
