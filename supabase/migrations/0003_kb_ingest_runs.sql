-- ============================================================================
-- 0003_kb_ingest_runs.sql
--
-- Phase 1.7 — KB ingest progress tracking + admin-configurable refresh cadence.
--
-- Adds:
--   - kb_ingest_runs           — one row per refresh run; updated as worker progresses
--   - admin_settings columns:
--       kb_refresh_cadence_hours    NULL = manual-only; 24 / 168 / 720 are the
--                                   canonical picker values
--       gravitas_sitemap_url        viewable in /admin/kb header (defaults to env)
--
-- Idempotent — safe to run more than once.
-- ============================================================================

begin;

create table if not exists public.kb_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running',           -- 'running' | 'completed' | 'failed'
  mode text not null default 'incremental',         -- 'incremental' | 'reseed'
  triggered_by text not null,                       -- 'cron' | 'admin:<email>' | 'cli'
  pages_planned int not null default 0,
  pages_fetched int not null default 0,
  pages_unchanged int not null default 0,
  pages_errored int not null default 0,
  chunks_embedded int not null default 0,
  error_message text
);

create index if not exists kb_ingest_runs_started_idx on public.kb_ingest_runs (started_at desc);
create index if not exists kb_ingest_runs_running_idx on public.kb_ingest_runs (status) where status = 'running';

alter table public.kb_ingest_runs enable row level security;

-- admin_settings extensions ---------------------------------------------------
alter table public.admin_settings
  add column if not exists kb_refresh_cadence_hours int;
alter table public.admin_settings
  add column if not exists gravitas_sitemap_url text;

-- Single-row defaults if the row exists from 0002 already.
update public.admin_settings
  set kb_refresh_cadence_hours = coalesce(kb_refresh_cadence_hours, 24),
      gravitas_sitemap_url = coalesce(gravitas_sitemap_url, 'https://thisisgravitas.com/sitemap.xml')
  where id = 1;

commit;
