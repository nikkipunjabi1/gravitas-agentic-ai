# Admin Panel

Internal-only dashboard for the Gravitas team to see what the Co-Pilot is doing, what visitors are asking, what's being spent, and what's broken.

**Principle:** if you can't see it on this panel, the Co-Pilot is flying blind. Every Anthropic dollar must be explainable here.

---

## Access

- Lives at `/admin/*` in the same Next.js app — same deploy, same Supabase, same domain. No separate service.
- Auth: **Supabase Auth magic-link login**, restricted to `@thisisgravitas.com` email domain via a database trigger that rejects sign-ups from other domains.
- Every `/admin/*` route is protected by middleware (`middleware.ts`) that checks the Supabase session and the email-domain allowlist before rendering. Unauthenticated requests are 302'd to `/admin/login`.
- Phase 1 has a single role (`admin`): authenticated `@thisisgravitas.com` users have full read access. Phase 2 introduces `viewer` vs `admin` if needed for gated actions.

## Read-only in Phase 1

No buttons that cost money or change state. The panel reads from Supabase tables and renders. Phase 2 adds gated actions (manual KB reseed, raise cap for the day, send "we're back" email to a waitlist row).

## Stack

| Concern | Choice |
|---|---|
| Auth | Supabase Auth (magic-link, email-domain allowlist) |
| Routing | Next.js App Router, `/admin/*` route group |
| Rendering | RSC by default (data-heavy, server-rendered) |
| Charts & KPI tiles | Tremor (`@tremor/react`) — Tailwind-aligned, dashboard-first, free/MIT |
| Tables | Tremor `<Table>` + shadcn primitives |
| Date / time | `date-fns` |
| CSV export (Phase 2) | `papaparse` |

Avoid: dragging in a heavy admin-template library (refine, react-admin). The needs are bounded; Tremor + Tailwind is enough.

## Routes (Phase 1 unless marked)

```
/admin/login                          public — magic link
/admin                                dashboard home
/admin/sessions                       sessions table + filters
/admin/sessions/[id]                  single session transcript
/admin/queries                        recent visitor opener messages
/admin/cost                  Phase 2  daily spend charts and breakdowns
/admin/kb                    Phase 2  KB ingest status, run history
/admin/waitlist              Phase 2  captured cap-reached emails
/admin/health                         tiny page: are Ollama/Chroma/worker/Anthropic reachable
/admin/settings              Phase 2  cap value, retention, alert recipients
```

## Views

### Dashboard `/admin`

A tile strip + two small lists. No deep analytics here — that's `/admin/cost`.

**Tiles**

| Tile | What |
|---|---|
| Today's spend | `$12.40 / $50` with a Tremor `ProgressBar`; sparkline of the last 30 days underneath. Colour: green < 70%, amber 70–90%, red > 90%. |
| Sessions today | Count, with delta vs yesterday |
| Sessions this week | Count, with delta vs last week |
| Leads captured today | Lead form + waitlist combined |
| Cap-blocked today | Count of `model_calls.was_blocked = true`. Red if > 0. |
| Lite-mode answers today | `cost_ledger.lite_mode_substitutions` for today. When > 0 it means the cap was hit and Ollama is handling light voice — site is still useful but downgraded. |
| Rate-limited IPs today | Count of distinct `ip_hash` rows where `turns_used >= IP_DAILY_TURN_LIMIT` OR `audits_used >= IP_DAILY_AUDIT_LIMIT`. Healthy state is low; spike suggests abuse or a viral moment. |
| Health | Four dots: Ollama, Chroma, Crawl worker, Anthropic. Click-through to `/admin/health`. |

**Recent sessions** — last 10 with timestamp, industry, terminal node, total cost. Click → session detail.

**Recent visitor openers** — last 10 first-messages with a one-line preview. Click → that session.

### Sessions `/admin/sessions`

Filterable table.

**Filters**

- Date range (default: last 7 days)
- Terminal node: completed / cap_reached / abandoned
- Has URL (yes/no)
- Industry
- Lead captured (yes/no)
- Cost: > $X

**Columns**

| Col | Notes |
|---|---|
| Start | When the session opened |
| Duration | ended_at − started_at |
| Industry | From visitor state |
| URL | If submitted |
| Terminal | Completed / Cap reached / Abandoned |
| UIActions | Pills showing types emitted |
| Cost | $ |
| Lead? | ✓ / — |

Sortable on every column. Sticky header. Pagination at 50/page. **No infinite scroll** — admins want stable rows under their cursor.

### Session detail `/admin/sessions/[id]`

The investigative view. Three columns:

**Left: timeline.** Chronological strip of every event in the session:

- 💬 visitor messages
- 🤖 agent responses (with the node that emitted them as a small tag)
- 🎨 `UIAction` emissions
- 🔧 tool calls (`crawl_url`, `kb_search`, `render_ui`)
- ⚙️ model calls (each call is a row: provider, model, purpose, tokens in/out, cost, latency)

Click any item to expand to full content.

**Right top: summary card.**

- Visitor metadata (industry, role, named problem, URL)
- Total cost, model breakdown, total tokens
- Terminal node, why it ended
- Lead captured? Email (masked unless admin clicks "reveal")

**Right bottom: transcript.** Just the chat-pane view of the session, as the visitor saw it. Useful for sharing with strategists for voice review.

Replay (Phase 2): a button that re-emits the session's UIActions into an embedded canvas for visual review.

### Visitor queries `/admin/queries`

The qualitative pulse — "what are people actually asking."

Phase 1: a paginated list of first-messages with a search box, filterable by date range. Each row links to the session.

Phase 2: topic clusters generated by a nightly Ollama job — top topics with counts and a weekly trend line. Click a cluster → all sessions tagged with that topic.

### Health `/admin/health`

Tiny page that hits four endpoints from the server and renders the result:

| Service | Check |
|---|---|
| Anthropic | `GET /v1/models` with the key — 200? |
| Ollama | `GET /api/tags` — 200, expected models listed? |
| Chroma | `GET /api/v1/heartbeat` — 200? |
| Crawl worker | `GET /health` with the shared secret — 200? |

Cache for 30s on the server to avoid hammering them. **No live polling from the client** — admin opens, sees status, refreshes if they want.

### Cost `/admin/cost` *(Phase 2)*

| Component | What |
|---|---|
| Daily spend line chart | 30/90/365 day toggle, $ on Y axis |
| Spend by model | Stacked bar (Sonnet vs Haiku vs Ollama-free); shows what the cap is actually protecting against |
| Spend by purpose | `voice` / `reasoning` / `classify` / `embed` — usually voice dominates |
| Spend by agent node | Discovery / Audit / Strategy / Mapping / Output |
| Per-session cost histogram | Spot expensive outliers |
| Top 10 expensive sessions | Click-through to transcripts |

### Knowledge base `/admin/kb` *(Phase 2)*

- Last ingest run: timestamp, pages crawled, pages skipped (unchanged), errors
- 30-day ingest history (small line chart of pages-crawled per day)
- Index size: page count, chunk count, MB
- Recent crawl errors (URL, status, error message)
- Phase 2: "reseed now" button (gated, asks for confirmation)

### Waitlist `/admin/waitlist` *(Phase 2)*

- Captured cap-reached emails, sortable by `captured_at`
- Status: pending / notified-at
- Phase 2: "send 'we're back' email" button (gated)

---

## Data sources

Every view reads from Supabase. The tables added for this panel:

### `sessions`

```sql
create table sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  terminal_node text,                            -- 'output' | 'cap_reached' | 'abandoned'
  visitor_industry text,
  visitor_role text,
  visitor_named_problem text,
  submitted_url text,
  lead_captured boolean not null default false,
  total_cost_usd numeric(10,4) not null default 0,
  ip_hash text,                                  -- hashed, not raw IP
  user_agent text,
  created_at timestamptz not null default now()
);
create index on sessions (started_at desc);
create index on sessions (terminal_node);
```

### `messages`

```sql
create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  role text not null,                            -- 'user' | 'assistant'
  content text not null,
  emitted_by_node text,                          -- 'discovery' | 'audit' | ... | null for user
  ts timestamptz not null default now()
);
create index on messages (session_id, ts);
```

### `model_calls`

```sql
create table model_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  node text,                                     -- which agent node initiated the call
  provider text not null,                        -- 'anthropic' | 'ollama'
  model text not null,
  purpose text not null,                         -- 'voice-light' | 'voice-light-degraded' | 'voice-heavy' | 'reasoning' | 'classify' | 'embed' | 'intent'
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10,6) not null default 0,
  latency_ms int,
  was_blocked boolean not null default false,    -- true if router refused due to cap
  ts timestamptz not null default now()
);
create index on model_calls (ts desc);
create index on model_calls (session_id);
create index on model_calls (was_blocked) where was_blocked = true;
```

### `ui_actions_emitted`

```sql
create table ui_actions_emitted (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  action_id uuid not null,                       -- the UIAction's own id (for replace semantics)
  action_type text not null,                     -- 'AuditFindings' | 'MaturityChart' | ...
  payload jsonb not null,
  ts timestamptz not null default now()
);
create index on ui_actions_emitted (session_id, ts);
```

### `tool_calls` *(Phase 2 — Phase 1 logs only model_calls)*

```sql
create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  tool text not null,
  args_summary text,                             -- redacted summary, not raw args
  result_summary text,
  latency_ms int,
  ts timestamptz not null default now()
);
```

Existing tables we read from: `cost_ledger` (now includes `lite_mode_substitutions`), `waitlist`, `kb_documents`, `ip_quota` (per-IP daily turn + audit counters — see `ARCHITECTURE.md` → Rate limiting).

---

## The logging chokepoint

All Anthropic and Ollama calls go through `src/lib/models/router.ts`. The router:

1. Reads today's `cost_ledger` row
2. Estimates the call cost (pre-flight)
3. If cap would exceed: writes `model_calls` row with `was_blocked = true`, throws `DailyCapExceeded`
4. Otherwise: makes the call, reads actual usage from the response, writes `model_calls` row with real numbers, updates `cost_ledger`

**This is the single point where cost is enforced AND logged.** Don't sprinkle `db.insert("model_calls", ...)` elsewhere. If a provider call exists outside this router, it's a bug.

Similarly, `UIAction` emissions go through `src/lib/stream/ui-action.ts` — which validates the action AND writes a `ui_actions_emitted` row.

Session lifecycle: `src/server/sessions.ts` writes the `sessions` row on first message and updates `terminal_node`, `ended_at`, `total_cost_usd` when the graph terminates.

---

## Post-hoc analytics — Ollama only

Anything that runs in batch on the log tables — topic clustering on `messages`, intent extraction, weekly summaries — runs on **Ollama**, not Claude. Otherwise the admin panel eats the $50 cap.

The nightly batch job lives in `worker/src/analytics.ts` and runs after the KB refresh at 05:00 UTC.

---

## Privacy and retention

- A short notice in the Co-Pilot footer: *"Conversations are logged for quality and to improve recommendations."*
- Email addresses in `waitlist` and lead form rows are encrypted at rest (Supabase Vault or column-level pgcrypto).
- `ip_hash` is `sha256(ip + SESSION_SIGNING_SECRET)` — pseudonymous, never raw IP.
- **90-day retention** on `sessions`, `messages`, `model_calls`, `ui_actions_emitted`, `tool_calls`. Configurable via `SESSION_RETENTION_DAYS`.
- A nightly cron in the worker deletes rows older than the retention window.
- Aggregated stats (`cost_ledger`, daily counts in a `daily_rollups` table when added) are kept indefinitely — no PII in them.
- Admin views log no PII to external tooling.
- A `/admin/sessions/[id]/delete` endpoint (Phase 2) supports GDPR-style erasure on demand.

---

## What the panel will NOT do (Phase 1)

- No real-time streaming view of an active session (Phase 3, if ever)
- No multi-tenant — single Gravitas org, single workspace
- No PDF export of dashboards (Phase 2 adds CSV)
- No mobile-optimized layout — admins use laptops
- No alerting (Slack / email) — that's Phase 3 with `alerts` config in `/admin/settings`

---

## Definition of Done — Phase 1 admin

- A `@thisisgravitas.com` user can sign in via magic link; a non-Gravitas email is refused at the database trigger
- Dashboard loads in < 1s and shows the six tiles + two lists
- Sessions table filters and paginates without bugs
- Session detail page renders the full transcript + tool calls + model calls inline
- Health page returns within 5s with all four checks
- A simulated `DailyCapExceeded` event appears in the dashboard within 30s of occurring (via simple page refresh — no websockets in Phase 1)
- Retention cron runs nightly in staging and deletes test rows older than the window
