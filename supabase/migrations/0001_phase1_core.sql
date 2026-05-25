-- ============================================================================
-- 0001_phase1_core.sql
--
-- Phase 1 core schema for the Gravitas Transformation Co-Pilot.
--
-- Tables created (see docs/ARCHITECTURE.md + docs/ADMIN_PANEL.md):
--   sessions             — one row per visitor session
--   messages             — every visitor/agent turn
--   model_calls          — every Anthropic + Ollama call (the chokepoint log)
--   ui_actions_emitted   — every UIAction with payload (replay source)
--   cost_ledger          — daily Anthropic spend cap state
--   waitlist             — captured emails when daily cap is hit
--   ip_quota             — per-IP daily turn + audit counters
--   kb_documents         — Gravitas KB ingest manifest
--
-- RPC functions:
--   ledger_record_estimate(numeric)
--   ledger_record_actual(numeric, numeric)
--   ledger_record_blocked()
--   ledger_record_lite_swap()
--   quota_consume_turn(text, int)
--   quota_consume_audit(text, int)
--   quota_get(text)
--
-- All ledger / quota mutations go through these RPC functions so they're
-- atomic at the database (no read-modify-write race in the app layer).
--
-- RLS: enabled on every table; only the service_role connects from server code.
-- Admin reads go through SECURITY DEFINER views in 0002 (later if needed).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  terminal_node text,                              -- 'output' | 'cap_reached' | 'abandoned'
  visitor_industry text,
  visitor_role text,
  visitor_named_problem text,
  submitted_url text,
  lead_captured boolean not null default false,
  total_cost_usd numeric(10,4) not null default 0,
  ip_hash text,                                    -- sha256(ip + SESSION_SIGNING_SECRET), never raw
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists sessions_started_at_idx on public.sessions (started_at desc);
create index if not exists sessions_terminal_node_idx on public.sessions (terminal_node);
create index if not exists sessions_ip_hash_idx on public.sessions (ip_hash);

alter table public.sessions enable row level security;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  role text not null,                              -- 'user' | 'assistant'
  content text not null,
  emitted_by_node text,                            -- 'discovery' | 'audit' | ... | null for user
  ts timestamptz not null default now()
);

create index if not exists messages_session_ts_idx on public.messages (session_id, ts);

alter table public.messages enable row level security;

-- ---------------------------------------------------------------------------
-- model_calls
-- ---------------------------------------------------------------------------
create table if not exists public.model_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions(id) on delete cascade,
  node text,                                       -- which agent node initiated
  provider text not null,                          -- 'anthropic' | 'ollama'
  model text not null,
  purpose text not null,                           -- 'voice-light' | 'voice-light-degraded' | 'voice-heavy' | 'reasoning' | 'classify' | 'embed' | 'intent'
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10,6) not null default 0,
  latency_ms int,
  was_blocked boolean not null default false,
  ts timestamptz not null default now()
);

create index if not exists model_calls_ts_idx on public.model_calls (ts desc);
create index if not exists model_calls_session_idx on public.model_calls (session_id);
create index if not exists model_calls_blocked_idx on public.model_calls (was_blocked) where was_blocked = true;

alter table public.model_calls enable row level security;

-- ---------------------------------------------------------------------------
-- ui_actions_emitted
-- ---------------------------------------------------------------------------
create table if not exists public.ui_actions_emitted (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  action_id uuid not null,                         -- the UIAction's own id (for replace semantics)
  action_type text not null,
  payload jsonb not null,
  ts timestamptz not null default now()
);

create index if not exists ui_actions_session_ts_idx on public.ui_actions_emitted (session_id, ts);
create index if not exists ui_actions_action_id_idx on public.ui_actions_emitted (action_id);

alter table public.ui_actions_emitted enable row level security;

-- ---------------------------------------------------------------------------
-- cost_ledger — daily Anthropic spend cap state
-- ---------------------------------------------------------------------------
create table if not exists public.cost_ledger (
  date date primary key,
  estimated_spend numeric(10,6) not null default 0,
  actual_spend numeric(10,6) not null default 0,
  calls_made int not null default 0,
  calls_blocked int not null default 0,
  lite_mode_substitutions int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.cost_ledger enable row level security;

-- ---------------------------------------------------------------------------
-- waitlist — emails captured when daily cap is hit
-- NOTE (docs/ADMIN_PANEL.md → Privacy and retention): the email column is
-- plain TEXT in Phase 1 because the table is empty by default and we accept
-- the trade-off for now. Phase 2 SHOULD migrate to bytea + pgp_sym_encrypt
-- (pgcrypto) with the key in Supabase Vault. Decision in the docs.
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  captured_at timestamptz not null default now(),
  session_id uuid references public.sessions(id) on delete set null,
  intended_url text,
  source text not null,                            -- 'daily_cap' | 'manual' | ...
  notified_at timestamptz
);

create index if not exists waitlist_captured_at_idx on public.waitlist (captured_at desc);
create index if not exists waitlist_pending_idx on public.waitlist (notified_at) where notified_at is null;

alter table public.waitlist enable row level security;

-- ---------------------------------------------------------------------------
-- ip_quota — per-IP daily turn + audit counters (anti-abuse)
-- ---------------------------------------------------------------------------
create table if not exists public.ip_quota (
  ip_hash text not null,
  date date not null,
  turns_used int not null default 0,
  audits_used int not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (ip_hash, date)
);

alter table public.ip_quota enable row level security;

-- ---------------------------------------------------------------------------
-- kb_documents — Gravitas KB ingest manifest
-- ---------------------------------------------------------------------------
create table if not exists public.kb_documents (
  url text primary key,
  last_modified timestamptz,
  content_hash text,
  chunk_count int not null default 0,
  indexed_at timestamptz,
  status text not null default 'pending',          -- 'pending' | 'indexed' | 'error'
  error_message text
);

create index if not exists kb_documents_indexed_at_idx on public.kb_documents (indexed_at desc);
create index if not exists kb_documents_status_idx on public.kb_documents (status);

alter table public.kb_documents enable row level security;

-- ============================================================================
-- RPC functions — atomic ledger + quota mutations
-- ============================================================================

-- Ledger ---------------------------------------------------------------------

create or replace function public.ledger_record_estimate(p_estimated_cost numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cost_ledger as cl (date, estimated_spend, calls_made)
  values (current_date, p_estimated_cost, 1)
  on conflict (date) do update
    set estimated_spend = cl.estimated_spend + excluded.estimated_spend,
        calls_made = cl.calls_made + 1,
        updated_at = now();
end;
$$;

create or replace function public.ledger_record_actual(
  p_actual_cost numeric,
  p_estimated_cost numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cost_ledger as cl (date, actual_spend, estimated_spend)
  values (current_date, p_actual_cost, p_actual_cost - p_estimated_cost)
  on conflict (date) do update
    set actual_spend = cl.actual_spend + p_actual_cost,
        -- Adjust estimate toward truth: subtract the pre-flight estimate,
        -- add the real cost. Net effect over time: estimated → actual.
        estimated_spend = cl.estimated_spend + (p_actual_cost - p_estimated_cost),
        updated_at = now();
end;
$$;

create or replace function public.ledger_record_blocked()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cost_ledger as cl (date, calls_blocked)
  values (current_date, 1)
  on conflict (date) do update
    set calls_blocked = cl.calls_blocked + 1,
        updated_at = now();
end;
$$;

create or replace function public.ledger_record_lite_swap()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cost_ledger as cl (date, lite_mode_substitutions)
  values (current_date, 1)
  on conflict (date) do update
    set lite_mode_substitutions = cl.lite_mode_substitutions + 1,
        updated_at = now();
end;
$$;

-- Quota ----------------------------------------------------------------------
--
-- Returns the row AFTER incrementing. Caller checks turns_used <= limit;
-- if turns_used > limit, the consume was rejected — see app-layer check below.
-- Actually we enforce server-side here: if turns_used would exceed limit,
-- we DO NOT increment and return the existing row.

create or replace function public.quota_consume_turn(
  p_ip_hash text,
  p_limit int
)
returns table (turns_used int, audits_used int, accepted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ip_quota%rowtype;
begin
  -- Lock the row for this ip_hash/date to prevent concurrent races.
  select * into v_row from public.ip_quota
    where ip_hash = p_ip_hash and date = current_date
    for update;

  if not found then
    insert into public.ip_quota (ip_hash, date, turns_used, audits_used)
    values (p_ip_hash, current_date, 1, 0)
    returning public.ip_quota.turns_used, public.ip_quota.audits_used
    into turns_used, audits_used;
    accepted := true;
    return next;
    return;
  end if;

  if v_row.turns_used >= p_limit then
    turns_used := v_row.turns_used;
    audits_used := v_row.audits_used;
    accepted := false;
    return next;
    return;
  end if;

  update public.ip_quota
    set turns_used = v_row.turns_used + 1,
        last_seen_at = now()
    where ip_hash = p_ip_hash and date = current_date
    returning public.ip_quota.turns_used, public.ip_quota.audits_used
    into turns_used, audits_used;
  accepted := true;
  return next;
end;
$$;

create or replace function public.quota_consume_audit(
  p_ip_hash text,
  p_limit int
)
returns table (turns_used int, audits_used int, accepted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ip_quota%rowtype;
begin
  select * into v_row from public.ip_quota
    where ip_hash = p_ip_hash and date = current_date
    for update;

  if not found then
    insert into public.ip_quota (ip_hash, date, turns_used, audits_used)
    values (p_ip_hash, current_date, 0, 1)
    returning public.ip_quota.turns_used, public.ip_quota.audits_used
    into turns_used, audits_used;
    accepted := true;
    return next;
    return;
  end if;

  if v_row.audits_used >= p_limit then
    turns_used := v_row.turns_used;
    audits_used := v_row.audits_used;
    accepted := false;
    return next;
    return;
  end if;

  update public.ip_quota
    set audits_used = v_row.audits_used + 1,
        last_seen_at = now()
    where ip_hash = p_ip_hash and date = current_date
    returning public.ip_quota.turns_used, public.ip_quota.audits_used
    into turns_used, audits_used;
  accepted := true;
  return next;
end;
$$;

create or replace function public.quota_get(p_ip_hash text)
returns table (turns_used int, audits_used int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select coalesce(iq.turns_used, 0), coalesce(iq.audits_used, 0)
    from public.ip_quota iq
    where iq.ip_hash = p_ip_hash and iq.date = current_date;
  if not found then
    turns_used := 0;
    audits_used := 0;
    return next;
  end if;
end;
$$;

commit;
