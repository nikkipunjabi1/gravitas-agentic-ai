-- ============================================================================
-- 0002_admin_email_guard.sql
--
-- Restrict Supabase Auth sign-ups to the configured admin domain (default:
-- @thisisgravitas.com). A BEFORE-INSERT trigger on auth.users raises an
-- exception for any other domain.
--
-- The allowed domain is read from a single-row settings table so it's
-- configurable without re-running migrations. Defaults to thisisgravitas.com.
-- ============================================================================

begin;

create table if not exists public.admin_settings (
  id smallint primary key default 1,
  admin_email_domain text not null default 'thisisgravitas.com',
  updated_at timestamptz not null default now(),
  constraint admin_settings_single_row check (id = 1)
);

insert into public.admin_settings (id) values (1) on conflict (id) do nothing;

alter table public.admin_settings enable row level security;

-- ----------------------------------------------------------------------------
-- Trigger: reject non-allow-listed domains
-- ----------------------------------------------------------------------------
create or replace function public.enforce_admin_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text;
  v_domain text;
begin
  select admin_email_domain into v_allowed from public.admin_settings where id = 1;
  if v_allowed is null or length(v_allowed) = 0 then
    -- Defensive: if config row missing, fail closed.
    raise exception 'admin_email_domain is not configured';
  end if;

  if new.email is null then
    raise exception 'email is required';
  end if;

  v_domain := lower(split_part(new.email, '@', 2));
  if v_domain <> lower(v_allowed) then
    raise exception 'admin sign-ups restricted to @%', v_allowed;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_admin_email_domain_trg on auth.users;
create trigger enforce_admin_email_domain_trg
  before insert on auth.users
  for each row execute function public.enforce_admin_email_domain();

commit;
