-- ============================================================================
-- 0004_kb_notifications.sql
--
-- Phase 1.8 — Email notifications for KB ingest runs.
--
-- Adds three columns to admin_settings:
--   kb_notify_emails           text[]   — recipients (multiple allowed)
--   kb_notify_on_success       boolean  — default true
--   kb_notify_on_failure       boolean  — default true
--
-- The worker reads these after each kb_ingest_runs row finalises and emails
-- the matching recipients via SMTP. SMTP credentials live in env vars, not
-- the database — see SMTP_HOST / SMTP_USER / SMTP_PASSWORD in .env.example.
--
-- Idempotent — safe to run more than once.
-- ============================================================================

begin;

alter table public.admin_settings
  add column if not exists kb_notify_emails text[] not null default '{}';
alter table public.admin_settings
  add column if not exists kb_notify_on_success boolean not null default true;
alter table public.admin_settings
  add column if not exists kb_notify_on_failure boolean not null default true;

commit;
