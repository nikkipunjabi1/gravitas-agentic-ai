-- 0007_pgvector_kb.sql
--
-- Move the knowledge-base vector store from ChromaDB → Supabase pgvector.
--
-- Why: Chroma lived in its own Docker container — fine for production
-- but a friction point for inspection (no UI, separate process) and for
-- bespoke deployments (every client needs their own Chroma). pgvector
-- lives inside the same Postgres that already holds kb_documents and
-- session data; admins can read the chunks directly via Supabase Studio
-- AND a new /admin/kb chunks viewer.
--
-- Storage shape:
--   - public.kb_chunks: one row per chunk. content (text) + embedding
--     (vector(768)) + a metadata jsonb sidecar matching what Chroma
--     stored under metadatas.
--   - cosine-distance index for kNN search.
--   - kb_chunks_search() SQL function the agent calls via RPC.
--
-- Migration story for existing Chroma data: there is none in the
-- typical dev environment (Chroma wasn't running). For production
-- environments that DO have Chroma data, a future `pnpm kb:reseed`
-- run rebuilds everything in pgvector from the canonical sitemap.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- kb_chunks — one row per embedded chunk
-- ---------------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id text primary key,
  -- Soft FK — kb_documents.url is unique but not a primary key in the
  -- current schema. Cascade is implemented in app code (the worker
  -- deletes a doc's chunks before re-embedding).
  document_url text not null,
  -- Chunk content for display + the agent's "show me the source"
  -- prompts. Truncated to 16 KB so a runaway chunk doesn't blow the
  -- table up; the worker's CHUNK_TARGET_CHARS is 1200 so this is a
  -- generous backstop.
  content text not null,
  -- 768-dim — matches Ollama nomic-embed-text's output. If the model
  -- ever changes, alter this column to the new dim.
  embedding vector(768),
  -- title / section / source-url / chunk-index — copies of what Chroma
  -- stored under metadatas. JSONB so we don't tie schema to provider.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists kb_chunks_document_url_idx
  on public.kb_chunks (document_url);

-- IVFFlat — cheap to build, fast at ~100k vectors. `lists = 100` is a
-- reasonable default for our scale (a few hundred KB pages × a handful
-- of chunks each). At 10M+ vectors switch to HNSW.
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Touch updated_at on every update.
create or replace function public.kb_chunks_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_kb_chunks_touch on public.kb_chunks;
create trigger trg_kb_chunks_touch
  before update on public.kb_chunks
  for each row execute function public.kb_chunks_touch_updated_at();

-- RLS: only the service role reads/writes. Agent + worker + admin panel
-- all use the service-role client, so we don't need user-scoped policies.
alter table public.kb_chunks enable row level security;
drop policy if exists "service role only" on public.kb_chunks;
create policy "service role only"
  on public.kb_chunks for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- kb_chunks_search — kNN search RPC used by src/lib/kb/search.ts
-- ---------------------------------------------------------------------------
-- Returns chunks ordered by cosine distance ascending (smaller = more
-- similar). `<=>` is the cosine-distance operator pgvector ships with.
create or replace function public.kb_chunks_search(
  p_embedding vector(768),
  p_limit int default 4
) returns table (
  id text,
  document_url text,
  content text,
  metadata jsonb,
  distance float
) language sql stable as $$
  select
    id,
    document_url,
    content,
    metadata,
    embedding <=> p_embedding as distance
  from public.kb_chunks
  where embedding is not null
  order by embedding <=> p_embedding
  limit p_limit;
$$;

revoke all on function public.kb_chunks_search(vector(768), int) from public;
grant execute on function public.kb_chunks_search(vector(768), int) to service_role;

-- ---------------------------------------------------------------------------
-- kb_chunks_delete_for_document — bulk-delete chunks for one URL.
-- Used by the worker before re-embedding a changed page.
-- ---------------------------------------------------------------------------
create or replace function public.kb_chunks_delete_for_document(
  p_document_url text
) returns int language plpgsql as $$
declare
  affected int;
begin
  delete from public.kb_chunks where document_url = p_document_url;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.kb_chunks_delete_for_document(text) from public;
grant execute on function public.kb_chunks_delete_for_document(text) to service_role;

comment on table public.kb_chunks is
  'Vector store for the KB. Replaces ChromaDB as of P1.17 — content + embedding live in Postgres for easier admin inspection + no Docker dependency.';
