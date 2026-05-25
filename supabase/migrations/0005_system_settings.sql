-- 0005_system_settings.sql
--
-- system_settings — admin-tunable runtime values that need to change
-- without a redeploy. Single source of truth for things like the per-IP
-- audit / turn caps; previously these were env-only.
--
-- Schema is intentionally generic (key/value/jsonb) so we don't need a
-- migration per new knob — admins can add freely. Existing callers:
--
--   ip_daily_turn_limit   integer  → consumeTurn / consumeAudit limits
--   ip_daily_audit_limit  integer
--
-- Reads from this table are cached app-side for ~60s so we don't hammer
-- Postgres on every chat turn. See src/server/settings.ts.

create table if not exists public.system_settings (
  key         text        primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text -- email of the admin who last touched this; nullable for seeds
);

-- Seed defaults. Each value is a JSON literal so we can later mix types
-- (booleans, strings, structs) without changing the column type.
insert into public.system_settings (key, value, description) values
  ('ip_daily_turn_limit',  '20', 'Maximum chat turns one IP may consume per UTC day before being rate-limited.'),
  ('ip_daily_audit_limit', '3',  'Maximum URL audits (full Lighthouse crawl) one IP may consume per UTC day.')
on conflict (key) do nothing;

-- Touch updated_at on every write — saves us writing it in app code.
create or replace function public.system_settings_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_system_settings_touch on public.system_settings;
create trigger trg_system_settings_touch
  before update on public.system_settings
  for each row
  execute function public.system_settings_touch_updated_at();

-- RLS — only the service role reads/writes from the server. The admin
-- panel goes through the API which uses the service-role client.
alter table public.system_settings enable row level security;

drop policy if exists "service role only" on public.system_settings;
create policy "service role only"
  on public.system_settings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- Reset helper — wipes today's ip_quota counters across ALL hashes. Used by
-- the admin "Reset today's quota" button so a demo can be re-run without
-- waiting for UTC midnight. Scoped to the current UTC date so yesterday's
-- audit logs are not touched (those are useful history).
-- ---------------------------------------------------------------------------
create or replace function public.quota_reset_today()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.ip_quota
  where date = (current_date at time zone 'utc');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.quota_reset_today() from public;
grant execute on function public.quota_reset_today() to service_role;
