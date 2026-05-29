# Admin Panel

Internal-only dashboard for the Gravitas team to see what the Co-Pilot is doing, what visitors are asking, what's being spent, and what's broken.

**Principle:** if you can't see it on this panel, the Co-Pilot is flying blind. Every Anthropic dollar must be explainable here.

---

## Access

- Lives at `/admin/*` in the same Next.js app — same deploy, same Supabase, same domain. No separate service.
- Auth: **Supabase Auth magic-link login**, restricted to `@thisisgravitas.com` email domain via a database trigger that rejects sign-ups from other domains.
- Every `/admin/*` route is protected by middleware (`middleware.ts`) that checks the Supabase session and the email-domain allowlist before rendering. Unauthenticated requests are 302'd to `/admin/login`.
- M2 has a single role (`admin`): authenticated `@thisisgravitas.com` users have full read access. M4 introduces `viewer` vs `admin` if needed for gated actions.

## Read-only in M2; write actions arrive in M4

No buttons in M2 that cost money or change state. The panel reads from Supabase tables and renders. **M4** adds gated actions (manual KB reseed, raise cap for the day, send "we're back" email to a waitlist row).

## Stack

| Concern | Choice |
|---|---|
| Auth | Supabase Auth (magic-link, email-domain allowlist) |
| Routing | Next.js App Router, `/admin/*` route group |
| Rendering | RSC by default (data-heavy, server-rendered) |
| Charts & KPI tiles | Tremor (`@tremor/react`) — Tailwind-aligned, dashboard-first, free/MIT |
| Tables | Tremor `<Table>` + shadcn primitives |
| Date / time | `date-fns` |
| CSV export (M4) | `papaparse` |

Avoid: dragging in a heavy admin-template library (refine, react-admin). The needs are bounded; Tremor + Tailwind is enough.

## Routes (M2 unless marked)

```
/admin/login                          public — magic link
/admin                                dashboard home
/admin/sessions                       sessions table + filters (paginated)
/admin/sessions/[id]                  single session transcript (chat-style)
/admin/sessions/[id]/flow             agent-flow view: Mermaid diagram +
                                      phase cards + click-to-expand
                                      request/response payloads (P1.12 + P1.14 + P1.15)
/admin/queries                        recent visitor opener messages (paginated, P1.15)
/admin/kb                             KB ingest status, run history
/admin/kb/chunks?url=…                chunk-level inspector for one indexed
                                      page — text + metadata (P1.17)
/admin/settings                       tabbed: Rate limits, Branding (+ AI
                                      disclaimer text P1.19), Embed widget,
                                      Knowledge base, Agent prompts,
                                      Features (P1.11 + P1.16 + P1.18 + P1.19)
/admin/health                         live checks: Anthropic, Ollama, Supabase pgvector,
                                      Crawl worker, Playwright Chromium
/admin/cost                  Phase 2  daily spend charts (deferred from M4)
/admin/answers               Phase 2  curated answers (deferred from M4)
/admin/waitlist              Phase 2  captured cap-reached emails (deferred from M4)
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
| Health | Five dots: Anthropic, Ollama, Supabase pgvector, Crawl worker, Playwright Chromium. Click-through to `/admin/health`. |

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

Replay (M4): a button that re-emits the session's UIActions into an embedded canvas for visual review.

### Visitor queries `/admin/queries`

The qualitative pulse — "what are people actually asking."

Phase 1: a paginated list of first-messages with a search box, filterable by date range. Each row links to the session.

M4: topic clusters generated by a nightly Ollama job — top topics with counts and a weekly trend line. Click a cluster → all sessions tagged with that topic.

### Health `/admin/health`

Tiny page that hits four endpoints from the server and renders the result:

| Service | Check |
|---|---|
| Anthropic | `GET /v1/models` with the key — 200? |
| Ollama | `GET /api/tags` — 200, expected models listed? |
| Supabase pgvector | `kb_chunks_search` RPC reachable + reports current chunk count. (P1.17 — was a Chroma heartbeat check.) |
| Crawl worker | `GET /health` with the shared secret — 200? |

Cache for 30s on the server to avoid hammering them. **No live polling from the client** — admin opens, sees status, refreshes if they want.

### Cost `/admin/cost` *(M4)*

| Component | What |
|---|---|
| Daily spend line chart | 30/90/365 day toggle, $ on Y axis |
| Spend by model | Stacked bar (Sonnet vs Haiku vs Ollama-free); shows what the cap is actually protecting against |
| Spend by purpose | `voice` / `reasoning` / `classify` / `embed` — usually voice dominates |
| Spend by agent node | Discovery / Audit / Strategy / Mapping / Output |
| Per-session cost histogram | Spot expensive outliers |
| Top 10 expensive sessions | Click-through to transcripts |

### Knowledge base `/admin/kb` *(M4)*

- Last ingest run: timestamp, pages crawled, pages skipped (unchanged), errors
- 30-day ingest history (small line chart of pages-crawled per day)
- Index size: page count, chunk count, MB
- Recent crawl errors (URL, status, error message)
- M4: "reseed now" button (gated, asks for confirmation)

### Curated Answers `/admin/answers` *(M4)*

Admin-authored knowledge that the agent uses **on top of** the auto-crawled KB. The use case: you notice in topic clustering that 10–20 visitors are asking about a topic the auto-crawled site doesn't address well. You write the canonical Gravitas answer here. The agent starts using it for the next visitor, within seconds.

**Two-source KB:**

| Collection | Source | Cadence | Retrieval weight |
|---|---|---|---|
| `gravitas-kb` | Auto-crawled from thisisgravitas.com sitemap | Daily incremental | 1.0× (baseline) |
| `gravitas-curated` | This admin view | On save | **default 1.5×** (configurable per answer up to 5.0×) |

The agent's `kb_search` tool queries both, merges, and applies the weight. Curated answers don't replace the crawled site — they layer on top for topics you care about most.

**List view** — `/admin/answers`

- Table: title, tags, status, weight, updated_at, updated_by
- Filters: status (draft / published / archived), tag, date range
- Sort: updated_at desc default
- "New curated answer" button → editor

**Editor** — `/admin/answers/new` and `/admin/answers/[id]`

- Title (required, ≤ 120 chars)
- Body (required, Markdown with live preview pane)
- Tags (free-text array; autocompletes from existing tags)
- Trigger phrases (optional; exact-match overrides — if visitor's message contains any phrase, this answer surfaces regardless of embedding score)
- Weight (default 1.5, range 1.0–5.0, with a tooltip explaining the multiplier)
- Status: draft (not retrieved) / published (live) / archived (preserved, not retrieved)
- Save → writes Supabase row → calls `worker/kb/embed-curated` → Ollama embeds + chunks → upserts to `gravitas-curated` Chroma collection. Indicator shows "indexed at HH:MM" once complete.

**Workflow from topic clustering** — the high-value loop

In `/admin/queries` (M4), when a topic cluster shows ≥ N sessions in the last N days, a **"Create curated answer for this topic"** button appears on the cluster row. Click → editor pre-filled with:

- `title` ← topic label (editable)
- `tags` ← the cluster's auto-extracted tags
- `body` ← a draft scaffold: *"At Gravitas, we approach [topic] by..."* with three to five visitor sample messages quoted below as context for the writer

The admin writes the canonical answer, hits Save, and the next visitor who asks something semantically close gets the answer the team wrote — not whatever the LLM paraphrased from the marketing site.

**Audit / history**

- `created_by` and `updated_by` on every row (Supabase user reference)
- Edits show in `/admin/sessions` retroactively: if a curated answer surfaced in a session, the session's transcript view marks the assistant message with "via curated answer: [title] →" linking to the version that was active at the time
- Backlog: a `curated_answer_versions` append-only table to support time-travel ("show me what was active two weeks ago"). M4 keeps a single row updated in place.

**Data schema**

```sql
create table curated_answers (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,                            -- Markdown
  tags text[] not null default '{}',
  trigger_phrases text[] not null default '{}',  -- optional exact-match overrides
  weight numeric not null default 1.5 check (weight >= 1.0 and weight <= 5.0),
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  last_embedded_at timestamptz,
  chunk_count int not null default 0
);
create index on curated_answers (status, updated_at desc);
create index on curated_answers using gin (tags);
```

**Embedding flow**

1. Admin hits Save in `/admin/answers/[id]`
2. Row written to Supabase
3. `worker/kb/embed-curated` invoked with the row ID
4. Worker fetches the row, chunks the body (~500-token chunks with 50-token overlap), embeds via Ollama `nomic-embed-text`, upserts to `gravitas-curated` Chroma collection with metadata: `{ id, title, tags, weight, version }`
5. On success, worker updates `last_embedded_at` and `chunk_count` on the row
6. UI shows "indexed at HH:MM" indicator

**Failure modes**

- Embedding fails → row stays at the old `last_embedded_at`; admin sees a warning banner: "This answer hasn't re-indexed since [time]. Save again to retry."
- Ollama unreachable → fall back to queuing the embed job; retry on Ollama recovery. Don't block the Save.

### Waitlist `/admin/waitlist` *(M4)*

- Captured cap-reached emails, sortable by `captured_at`
- Status: pending / notified-at
- M4: "send 'we're back' email" button (gated)

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

### `tool_calls` *(M4 — M2 logs only model_calls and ui_actions_emitted)*

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

Existing tables we read from: `cost_ledger` (now includes `lite_mode_substitutions`), `waitlist`, `kb_documents`, `ip_quota` (per-IP daily turn + audit counters — see `ARCHITECTURE.md` → Rate limiting), `curated_answers` (M4; admin-authored knowledge layered on top of the auto-crawled KB).

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
- A `/admin/sessions/[id]/delete` endpoint (M4) supports GDPR-style erasure on demand.

---

## What the panel will NOT do (within Phase 1)

- No real-time streaming view of an active session (backlog)
- No multi-tenant — single Gravitas org, single workspace
- No PDF export of dashboards (M4 adds CSV)
- No mobile-optimized layout — admins use laptops
- Alerting (Slack / email) arrives in M6 with `alerts` config in `/admin/settings`

---

## Definition of Done — M2 admin (read-only baseline)

- A `@thisisgravitas.com` user can sign in via magic link; a non-Gravitas email is refused at the database trigger
- Dashboard loads in < 1s and shows the six tiles + two lists
- Sessions table filters and paginates without bugs
- Session detail page renders the full transcript + tool calls + model calls inline
- Health page returns within 5s with all four checks
- A simulated `DailyCapExceeded` event appears in the dashboard within 30s of occurring (via simple page refresh — no websockets in Phase 1)
- Retention cron runs nightly in staging and deletes test rows older than the window
