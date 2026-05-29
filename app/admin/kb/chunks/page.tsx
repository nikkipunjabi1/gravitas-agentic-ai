import Link from "next/link";
import { listChunksForDocument } from "@/lib/kb/pgvector";
import { isSupabaseConfigured } from "@/server/supabase/client";

export const dynamic = "force-dynamic";

/**
 * /admin/kb/chunks?url=... — inspect the actual chunks for one indexed
 * page. Shows the chunk content + metadata + embedding-presence flag for
 * every row in kb_chunks where document_url = the supplied URL.
 *
 * Linked from the "Indexed pages" table on /admin/kb. The chunks
 * themselves live in Supabase pgvector (P1.17) so admins can also browse
 * them directly via Supabase Studio if they prefer raw SQL.
 *
 * Why pgvector + not Chroma: easier inspection, no Docker dependency,
 * one fewer service per client deployment.
 */
export default async function ChunksPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Empty
        title="Supabase isn't configured"
        body="The chunks viewer reads from kb_chunks in Supabase. Set the env vars and apply migration 0007_pgvector_kb.sql."
      />
    );
  }

  const sp = await searchParams;
  const url = sp.url ?? "";
  if (!url) {
    return (
      <Empty
        title="No URL specified"
        body="Open this page via a row in /admin/kb → Indexed pages."
        backHref="/admin/kb"
      />
    );
  }

  const chunks = await listChunksForDocument(url);

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Link
          href="/admin/kb"
          className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink"
        >
          ← Knowledge base
        </Link>
        <h1 className="font-display text-2xl font-semibold text-ink">
          Chunks for this page
        </h1>
        <div className="flex flex-wrap items-baseline gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-ink underline decoration-paper-edge underline-offset-2 hover:decoration-ink-muted"
          >
            {url} ↗
          </a>
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            {chunks.length} {chunks.length === 1 ? "chunk" : "chunks"}
          </span>
        </div>
        <p className="text-xs text-ink-soft">
          Each chunk is one row in <code className="font-mono text-ink">kb_chunks</code>.
          The agent retrieves the top-k closest chunks (by cosine distance) when a visitor
          asks about Gravitas. Click a chunk to see its full content + metadata.
        </p>
      </header>

      {chunks.length === 0 ? (
        <Empty
          title="No chunks indexed for this page"
          body="Either the URL hasn't been ingested yet, or the ingest produced no extractable content (no headings + paragraphs after stripping nav/footer/etc). Run a reseed from /admin/kb → Refresh now."
          backHref="/admin/kb"
        />
      ) : (
        <ol className="space-y-2">
          {chunks.map((c, i) => (
            <li key={c.id}>
              <details className="group rounded-xl border border-paper-edge bg-paper">
                <summary
                  className={`
                    flex cursor-pointer items-baseline justify-between gap-3 px-4 py-3 text-xs
                    list-none [&::-webkit-details-marker]:hidden
                  `}
                >
                  <div className="flex items-baseline gap-2 truncate">
                    <span
                      className="font-mono text-[9px] text-ink-muted/60 group-open:rotate-90 inline-block transition"
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      chunk #{i + 1}
                    </span>
                    {typeof c.metadata.section === "string" && c.metadata.section.length > 0 ? (
                      <span className="font-mono text-[10px] text-ink-muted">
                        · {c.metadata.section}
                      </span>
                    ) : null}
                    <span className="truncate text-ink-soft">
                      {previewText(c.content)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-muted">
                    {c.hasEmbedding ? (
                      <span className="rounded-full bg-emerald-100 px-1.5 text-[9px] text-emerald-900">
                        embedded
                      </span>
                    ) : (
                      <span className="rounded-full bg-severity-critical/15 px-1.5 text-[9px] text-severity-critical">
                        no embedding
                      </span>
                    )}
                    <span>{c.content.length} chars</span>
                  </div>
                </summary>
                <div className="space-y-3 border-t border-paper-edge bg-paper-soft/40 px-4 py-3">
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      Content
                    </p>
                    <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                      {c.content}
                    </pre>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      Metadata
                    </p>
                    <pre className="mt-1 overflow-auto rounded-md bg-paper px-3 py-2 font-mono text-[11px] leading-relaxed text-ink">
                      {safeStringify(c.metadata)}
                    </pre>
                  </div>
                  <div className="flex items-baseline justify-between font-mono text-[10px] text-ink-muted">
                    <span>id: {c.id}</span>
                    <span>updated {new Date(c.updatedAt).toLocaleString()}</span>
                  </div>
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function previewText(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return collapsed.slice(0, 79) + "…";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Empty({
  title,
  body,
  backHref,
}: {
  title: string;
  body: string;
  backHref?: string;
}) {
  return (
    <div className="rounded-xl border border-paper-edge bg-paper p-6">
      <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-ink-soft">{body}</p>
      {backHref ? (
        <p className="mt-4">
          <Link
            href={backHref}
            className="font-mono text-[11px] uppercase tracking-widest text-ink hover:underline"
          >
            ← Back
          </Link>
        </p>
      ) : null}
    </div>
  );
}
