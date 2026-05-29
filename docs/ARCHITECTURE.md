# Architecture

High-level system design. For the agent reasoning model, see `AGENTS.md`. For how the canvas renders, see `UI_CONTRACT.md`. For the moment-by-moment data flow of a turn, see `SESSION_FLOW.md`.

> **Important update — P1.17 (post-M6 polish).** The vector store moved from **ChromaDB → Supabase `pgvector`**. Everywhere this doc mentions Chroma / ChromaDB as a runtime service, read it as **the `kb_chunks` table in Supabase with the `vector(768)` column type and the `kb_chunks_search` RPC** (migration `0007_pgvector_kb.sql`). The Docker dependency is gone; chunks are browsable via Supabase Studio AND `/admin/kb/chunks?url=…`. Deployment topology drops one service.
>
> Other live-state notes:
> - The dev port is **:3001** (not :3000) — Next.js wouldn't bind to 3000 reliably on the dev box; everything's pinned in `package.json`.
> - Every visitor-facing surface (launcher text, colours, agent system prompts, KB sitemap + whitelist, rate limits, branding/contact) is admin-tunable from `/admin/settings` as of P1.16. The hardcoded constants in code are the fallback when no admin override is saved.
> - `/embed.js` is a Next.js route handler (not a static file), so changes to embed colours / text from the admin panel propagate within ~60 seconds of saving (subject to Cloudflare cache).

---

## Topology

```
┌─────────────────────────────────────────────────────────────┐
│                         Visitor browser                      │
│  ┌──────────────────────┐    ┌──────────────────────────┐    │
│  │  Chat pane (left)    │◄──►│  Canvas pane (right)     │    │
│  └──────────┬───────────┘    └──────────────────────────┘    │
└─────────────┼────────────────────────────▲──────────────────┘
              │ SSE / Data Stream          │ UIAction events
              ▼                            │ (in the same stream)
┌─────────────────────────────────────────────────────────────┐
│              Next.js app — Vercel (Edge + Node runtimes)     │
│                                                              │
│   /app/copilot          ← dual-pane UI                       │
│   /app/api/chat         ← streams LangGraph output           │
│   /app/api/canvas       ← (optional) validates UIActions     │
│                                                              │
│   ┌────────────────── src/agents ──────────────────────┐    │
│   │  LangGraph state machine, nodes, tools             │    │
│   └────────┬───────────┬──────────────┬────────────────┘    │
│            ▼           ▼              ▼                     │
│       Model router  Vector KB    Tool: crawl_url            │
│            │           │              │                     │
└────────────┼───────────┼──────────────┼─────────────────────┘
             ▼           ▼              ▼
       ┌─────────┐  ┌─────────┐  ┌──────────────────────┐
       │ Ollama  │  │Chroma   │  │  Crawl worker         │
       │(local/  │  │ /Qdrant │  │  (Fly.io / Railway)   │
       │ WSL)    │  │         │  │  Playwright+Cheerio   │
       └─────────┘  └─────────┘  │  Lighthouse           │
       ┌──────────┐              └──────────────────────┘
       │ Claude   │              ┌──────────────────────┐
       │ API      │              │  Supabase            │
       └──────────┘              │  (auth, sessions,    │
                                 │   leads, KB chunks)  │
                                 └──────────────────────┘
```

## Why this split

- **Next.js on Vercel** for the user-facing app and the agent runtime. Streams beautifully, ships fast, free tier.
- **Separate worker for Playwright** because headless browsers don't run on Vercel functions and crawls can take 10–30s. We do not want a chat request blocked by a crawl.
- **Hybrid model layer** because Ollama is free and fast enough for reasoning, but Claude Sonnet 4.6 produces the user-facing voice we need. See `AGENTS.md` for routing rules.
- **Supabase only** for both structured storage and vector storage (P1.17: `pgvector` extension on the same Postgres that hosts sessions/messages/etc.). Migrate to Qdrant only if pgvector hits a scale wall — irrelevant in Phase 1.

## Data flow — a typical session

1. Visitor opens `/copilot`. Server Component renders the shell.
2. Visitor sends a message. Client posts to `/api/chat` and opens an SSE stream.
3. The route handler initializes (or resumes) a LangGraph run with the visitor's session ID.
4. The graph executes nodes. Each node may:
   - Stream text deltas back over SSE (chat pane consumes these)
   - Emit a `UIAction` event over the same stream (canvas pane consumes these)
   - Call tools (model router, vector KB, crawl worker)
5. The crawl worker is a separate HTTP service. The `crawl_url` tool POSTs the URL and gets back structured JSON. The agent loop continues with that JSON in state.
6. When the graph reaches a terminal state, the stream closes. Session state is persisted to Supabase.

## Repo layout (target)

```
gravitas-agentic-ai/
├── app/
│   ├── (site)/                # public marketing-style pages, if any
│   ├── copilot/page.tsx       # the dual-pane experience
│   ├── api/
│   │   ├── chat/route.ts      # POST → streams agent output
│   │   └── canvas/route.ts    # optional: server-side UIAction validation
│   └── layout.tsx
├── src/
│   ├── agents/
│   │   ├── graph.ts           # LangGraph: nodes, edges, state schema
│   │   ├── state.ts           # zod schema for graph state
│   │   ├── nodes/
│   │   │   ├── discovery.ts
│   │   │   ├── audit.ts
│   │   │   ├── strategy.ts
│   │   │   ├── solution-map.ts
│   │   │   └── output.ts
│   │   └── tools/
│   │       ├── crawl-url.ts
│   │       ├── kb-search.ts
│   │       └── render-ui.ts   # the tool that emits a UIAction
│   ├── canvas/
│   │   ├── schema.ts          # UIAction discriminated union (zod)
│   │   ├── registry.tsx       # type → component map
│   │   └── components/
│   │       ├── audit-findings.tsx
│   │       ├── maturity-chart.tsx
│   │       ├── roadmap-widget.tsx
│   │       └── ...
│   ├── components/            # shadcn-based shared UI
│   ├── lib/
│   │   ├── models/
│   │   │   ├── router.ts      # routes by purpose → provider
│   │   │   ├── ollama.ts
│   │   │   └── claude.ts
│   │   ├── kb/
│   │   │   ├── embed.ts       # nomic-embed-text
│   │   │   ├── search.ts      # ChromaDB client
│   │   │   └── seed.ts        # one-off ingestion of Gravitas content
│   │   └── stream/
│   │       └── ui-action.ts   # named-event protocol over the AI SDK stream
│   └── server/                # server-only (db, secrets)
├── worker/
│   ├── src/index.ts           # Fastify HTTP server
│   ├── src/crawl.ts           # Playwright + Cheerio + Lighthouse
│   └── Dockerfile
├── docs/
├── tests/
├── .env.example
└── package.json
```

## Stack — concrete versions and choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 22 LTS | Inside WSL2 on dev, on Vercel/Fly in prod |
| Package manager | pnpm | Workspaces if/when we split packages |
| Web framework | Next.js (App Router, latest stable) | RSC + server actions where helpful |
| UI — primitives | Tailwind, shadcn/ui | No CSS-in-JS |
| UI — animation & polish | Framer Motion (component lifecycle) + GSAP (scroll + time) + Lenis (smooth scroll) + Aceternity UI patterns + Vaul + Sonner + next-themes | Dark-mode-only. Premium feel matching thisisgravitas.com. Full direction in `docs/BRANDING.md` → Visual design language. |
| Streaming | Vercel AI SDK (`ai`) | Data Stream Protocol with custom data parts for `UIAction` |
| Agent runtime | `@langchain/langgraph` (TS) | Stateful graph; persistence via Supabase checkpointer |
| Validation | `zod` | At every external boundary |
| Vector store | **Supabase `pgvector`** (P1.17) | Was ChromaDB; pgvector ships free in every Supabase project. Migrate to Qdrant only if pgvector hits a scale wall. |
| Embeddings | Ollama / `nomic-embed-text` | Free, runs alongside Ollama |
| LLM — reasoning | Ollama / DeepSeek-R1 | Local in dev, hosted Ollama-compatible endpoint in prod (or fallback to Claude Haiku) |
| LLM — output | Anthropic Claude Sonnet 4.6 (`claude-sonnet-4-6`) | API |
| Crawl | Playwright + Cheerio + Lighthouse (Node) | Runs in `worker/` |
| Storage | Supabase Postgres | Sessions, leads, audit results, KB chunks |
| Hosting (production) | **Railway** — one project hosts Next.js + crawl worker + Chroma | App, worker, vector store, and cron all in one project with private networking. See "Deployment paths". Vercel + Fly.io is the documented alternative. |
| Hosting (dev/demo) | Self-hosted on the developer's Windows + WSL2 box | Cloudflare Tunnel exposes it as `copilot.thisisgravitas.com`. See "Deployment paths" → Path A. |
| DNS / proxy / tunnel | Cloudflare (free tier) | DNS, SSL, DDoS protection, Tunnel for home-hosted Ollama. Free is sufficient — no paid plan needed. |
| Observability | Railway logs + Supabase logs + (M6) OpenTelemetry + Langfuse | Production tracing in M6 |

## Environment variables

Every one of these lives in `.env.local` (dev) and in Vercel/Fly secrets (prod). `.env.example` enumerates them with empty values.

```bash
# Models
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_REASONING_MODEL=deepseek-r1
OLLAMA_FAST_MODEL=qwen3
OLLAMA_EMBED_MODEL=nomic-embed-text

# Vector store
CHROMA_URL=http://localhost:8000
CHROMA_KB_COLLECTION=gravitas-kb

# Worker
CRAWL_WORKER_URL=http://localhost:8787
CRAWL_WORKER_SHARED_SECRET=

# KB ingest
GRAVITAS_SITEMAP_URL=https://thisisgravitas.com/sitemap.xml
KB_REFRESH_CRON=0 4 * * *           # daily at 04:00 UTC, running from M2

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
SESSION_SIGNING_SECRET=

# Cost cap
DAILY_COST_CAP_USD=50
COST_CAP_RESET_TZ=UTC

# Per-IP rate limits
IP_DAILY_TURN_LIMIT=20
IP_DAILY_AUDIT_LIMIT=1
COUNTER_VISIBLE_THRESHOLD=5

# Admin panel + logging
ADMIN_EMAIL_DOMAIN=thisisgravitas.com
SESSION_RETENTION_DAYS=90

# Branding — audit-report closing contact (see docs/BRANDING.md)
BRANDING_CLOSING_CONTACT_NAME=
BRANDING_CLOSING_CONTACT_ROLE=
BRANDING_CLOSING_CONTACT_PHONE=
BRANDING_CLOSING_CONTACT_EMAIL=
```

## Streaming protocol — chat + canvas in one stream

The chat pane and the canvas pane both consume `/api/chat`. Within the Vercel AI SDK Data Stream Protocol:

- **Text parts** → chat pane (rendered as the streaming assistant message)
- **Data parts** with type `ui-action` → canvas pane (parsed, validated against the `UIAction` zod schema, then dispatched to the canvas store)
- **Data parts** with type `tool-call` → debug-only, surfaced behind a dev flag

The frontend has a single stream consumer that demultiplexes by part type. **Do not open a second connection for the canvas** — that path leads to ordering bugs between "the agent said X" and "the agent rendered Y in response."

See `UI_CONTRACT.md` for the `UIAction` schema and dispatch.

## Gravitas knowledge base — ingest and refresh

The KB is the agent's grounding source for anything it says *about Gravitas itself* (services, case studies, POV, philosophy). It is **separate** from the per-session URL audit. Two different crawls, two different jobs.

### What gets ingested

Whitelist of URL patterns from thisisgravitas.com:

- `/` (homepage)
- `/about`
- `/services/*` (every service page)
- `/work/*` (every case study)
- `/insights/*` (POV / articles)

Explicitly **not**: privacy pages, cookie policy, paginated tag indexes, search pages.

### Pipeline

```
sitemap.xml ──► diff against kb_documents (Supabase) ──► fetch changed/new URLs
                                                                │
                                                                ▼
                                                Playwright + Cheerio extract
                                                                │
                                                                ▼
                                                  chunk + embed (nomic-embed-text)
                                                                │
                                                                ▼
                                                  upsert into ChromaDB collection
                                                                │
                                                                ▼
                                                  update kb_documents row
                                                  (url, hash, lastmod, indexedAt)
```

Lives in `worker/src/kb-ingest.ts` — same Node service that handles visitor URL audits, just a different HTTP entrypoint and CLI command.

### Cadence

| Milestone | Refresh strategy |
|---|---|
| M2 | Initial seed via `pnpm kb:reseed`, **plus** daily incremental cron (Railway Cron or equivalent hits `worker/kb/refresh` at 04:00 UTC). Sitemap-driven; only re-embeds pages whose `lastmod` or content hash changed. Discovery answers `gravitas-question` from this collection. |
| M3 | Same pipeline; the Strategy node starts consuming the KB for grounding and citations. |
| M4 | Second collection added: `gravitas-curated` (admin-authored via `/admin/answers`). `kb_search` becomes hybrid across both collections. |
| Backlog | CMS webhook for real-time index updates on publish. |

### Manual reseed

`pnpm kb:reseed` (in `worker/`) does a full re-crawl of the whitelist, regardless of `lastmod`. Use after schema changes, embedding-model upgrades, or when the team wants new content indexed immediately.

### Storage

- **ChromaDB collection** `gravitas-kb`: chunked content + embeddings + metadata (`url`, `title`, `section`, `service`, `chunkIndex`)
- **Supabase table** `kb_documents`: one row per URL with `url`, `last_modified`, `content_hash`, `chunk_count`, `indexed_at`, `status`. This is the diff source so we don't re-embed unchanged pages.

### Sanity checks

The ingest job emits metrics every run: pages crawled, pages skipped (unchanged), chunks embedded, errors. A run that crawls zero pages OR errors on > 10% of pages alerts via the M6 alert pipeline.

## Cost cap — daily Claude spend ceiling

A hard daily ceiling on Claude API spend. Default **$50/day**, configurable via `DAILY_COST_CAP_USD`. The router enforces it; agent nodes cannot bypass it.

### Why a cap
A single heavy audit pulls tens of thousands of input tokens through Claude Sonnet. Without a ceiling, a bored visitor or a misbehaving prompt loop could rack up triple-digit spend overnight. The cap turns "this could go badly" into "this stops gracefully."

### Light vs heavy purposes

Every call to the router carries a `purpose`. Purposes are tiered:

| Purpose | Tier | Typical use |
|---|---|---|
| `voice-light` | light | Discovery answering a KB question, Output closing message |
| `voice-heavy` | heavy | Audit narration, Strategy synthesis, Executive Brief composition |
| `reasoning` | (Ollama) | DeepSeek-R1, free |
| `classify` / `intent` | (Ollama) | Qwen3, free |
| `embed` | (Ollama) | nomic-embed-text, free |

Only `voice-light` and `voice-heavy` consume Anthropic spend. Both count toward the cap.

### How the cap is enforced

1. Every Anthropic-bound call runs a pre-flight estimate against today's row in the Supabase `cost_ledger` table.
2. Estimate = `input_tokens × INPUT_PRICE + max_output_tokens × OUTPUT_PRICE` (Sonnet 4.6 prices live in `src/lib/models/pricing.ts`).
3. If `today.estimated_spend + estimate > DAILY_COST_CAP_USD`:
   - For `voice-heavy`: router throws `DailyCapExceeded`, increments `calls_blocked`. **No Anthropic call is made.**
   - For `voice-light`: router silently **downgrades to lite mode** — swaps the call to Ollama (Qwen3), still returns a useful response. No exception thrown. Increments `lite_mode_substitutions` in the ledger.
4. After a successful Anthropic call, the router reconciles `today.actual_spend` with the real token usage.
5. The ledger resets at 00:00 UTC. Reset TZ is configurable via `COST_CAP_RESET_TZ`.

### Graceful degradation — "lite mode"

When the cap is breached, the site does NOT go dark. Heavy tasks block; light tasks keep working.

- A visitor asking "what does Gravitas do?" at 11pm after the cap is hit gets a real KB-grounded answer — composed by Qwen3 instead of Sonnet. Voice is ~80% as polished; informational value is identical.
- The lite-mode swap happens inside the router. Agent nodes don't know it happened.
- The session log marks the call's `provider` as `ollama` and `purpose` as `voice-light-degraded` so the admin panel can show "we served N lite-mode answers today."

### What the agent does on `voice-heavy` cap-hit

The graph has a **single fallback edge** from every node to a terminal `CapReached` node. That node:

- Composes a brief Gravitas-voiced acknowledgment (from a static template — no LLM call, since LLM calls are what got us here)
- Emits a `DailyCapReached` UIAction (see `UI_CONTRACT.md`) that renders an email-capture card in the canvas
- On submit, writes a row to the Supabase `waitlist` table with `email`, `captured_at`, `session_id`, `intended_url`, `source: "daily_cap"`
- Ends the session

M2 only captures the email. M4 adds the "send 'we're back' email" gated action in `/admin/waitlist` (via Resend or Supabase Auth's transactional email).

### Storage

- `cost_ledger` (Supabase): `date PRIMARY KEY, estimated_spend NUMERIC, actual_spend NUMERIC, calls_made INT, calls_blocked INT, lite_mode_substitutions INT`
- `waitlist` (Supabase): `id UUID, email TEXT, captured_at TIMESTAMPTZ, session_id UUID, intended_url TEXT NULL, source TEXT, notified_at TIMESTAMPTZ NULL`

### What does NOT count toward the cap

- **Ollama calls** — local, free
- **Crawl worker time** — no LLM cost, just CPU
- **Embeddings via Ollama** — local

Only Anthropic API calls count.

### Observability

The ledger doubles as a metric source. A small `/api/admin/cost` route (auth-gated, M4) exposes today's row and a 30-day history for dashboarding. If `calls_blocked > 0` for the day, that's a signal we either need to raise the cap or get smarter about prompt length.

## Admin panel

Internal-only dashboard at `/admin/*` for the Gravitas team. Full spec in `docs/ADMIN_PANEL.md`. Architectural rules:

- Same Next.js app, same Supabase, same deploy — not a separate service
- Auth via Supabase magic-link; database trigger restricts sign-ups to `@thisisgravitas.com`
- Middleware (`middleware.ts`) protects every `/admin/*` route
- Charts use Tremor (`@tremor/react`); avoid heavy admin-template libraries
- **Read-only in Phase 1** — no buttons that cost money or change state
- All logging flows through two chokepoints: `src/lib/models/router.ts` (writes `model_calls`) and `src/lib/stream/ui-action.ts` (writes `ui_actions_emitted`). Don't sprinkle logging elsewhere.
- Post-hoc analytics (topic clustering, intent extraction) runs on Ollama only — never Claude — to protect the daily cap

### Admin-related Supabase tables

Added on top of `cost_ledger` / `waitlist` / `kb_documents`:

- `sessions` — one row per visitor session (start/end, terminal node, visitor metadata, total cost, hashed IP)
- `messages` — every visitor/agent turn, ordered, tagged with emitting node
- `model_calls` — every Anthropic + Ollama call routed through the model router (tokens, cost, latency, `was_blocked`)
- `ui_actions_emitted` — every UIAction with payload (for replay)
- `tool_calls` *(M4)* — every tool invocation with redacted args/result summary

Schemas live in `docs/ADMIN_PANEL.md` so they're co-located with the views that read them.

### Retention

Phase 1 retention defaults: **90 days** on `sessions`, `messages`, `model_calls`, `ui_actions_emitted`. Configurable via `SESSION_RETENTION_DAYS`. A nightly cron in the worker deletes rows older than the window. Aggregated stats (`cost_ledger`) are kept indefinitely.

## Rate limiting — per-IP daily quotas

A second protection layer, independent of the cost cap. The cost cap protects total Anthropic spend; the rate limit protects against a single visitor monopolizing turns or repeatedly triggering audits.

### Two quotas, both per-IP per-day

| Quota | Default | Env var |
|---|---|---|
| Chat turns | 20 / IP / day | `IP_DAILY_TURN_LIMIT=20` |
| URL audits | 1 / IP / day | `IP_DAILY_AUDIT_LIMIT=1` |

Both reset at 00:00 UTC (same as `cost_ledger`).

### IP identity

We never store raw IPs. The `/api/chat` handler computes `ip_hash = sha256(req.ip + SESSION_SIGNING_SECRET)` on every request and uses that as the quota key. The hash is the same across a visitor's session but unrecoverable to a raw IP.

### Storage

`ip_quota` (Supabase):

```sql
create table ip_quota (
  ip_hash text not null,
  date date not null,
  turns_used int not null default 0,
  audits_used int not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (ip_hash, date)
);
```

### Enforcement

`src/lib/quota/ip-quota.ts` exposes:

```ts
async function consumeTurn(ipHash: string): Promise<QuotaResult>;
async function consumeAudit(ipHash: string): Promise<QuotaResult>;
async function getQuota(ipHash: string): Promise<{ turnsRemaining: number; auditsRemaining: number }>;
```

`/api/chat` calls `consumeTurn` BEFORE handing off to the agent graph. If it returns `exhausted`, the route emits a `RateLimitReached` UIAction and returns without running the graph.

The Audit node calls `consumeAudit` BEFORE invoking the crawl worker. If exhausted, it emits a `RateLimitReached` UIAction (different copy: "you've used today's deep audit") and routes to graceful end.

### UI surface

The chat composer reads `getQuota(ipHash)` on mount and after each turn, and shows the counter **only when ≤ `COUNTER_VISIBLE_THRESHOLD`** (default 5). For typical visitors with <5 turns, no counter is ever shown.

Counter text: *"17 of 20 turns remaining today"* — neutral, not alarmist.

When `turnsRemaining === 0`, the composer disables and the canvas shows `RateLimitReached`.

### Why per-IP isn't perfect (and why we use it anyway)

- NAT / corporate networks: many real users share one IP. Trade-off: 20-turn default is generous enough that this is rarely hit.
- VPNs / mobile carriers: one user can hop IPs. Trade-off: the cost cap is the backstop.
- Bots can rotate IPs. Trade-off: if bot traffic becomes real, add Cloudflare Turnstile in front of `/api/chat`.

Per-IP is the pragmatic default. Session-cookie-based limits are trivially bypassed; fingerprinting has privacy issues; email-gating kills conversion. We accept the imperfection.

## Branding assets

See `docs/BRANDING.md` for the full convention. Architectural rule:

- Brand assets (logo, eventually fonts/colours) live in `src/lib/branding/`
- The Gravitas logo is embedded as a base64 data URI at scaffold time via `pnpm branding:fetch` — no runtime fetch from `assets.thisisgravitas.com`
- Every visitor-facing artifact (canvas component, audit report, executive brief PDF, daily-cap card) imports the constant

This protects against asset-host outages and lets PDF generators run in sandboxes without network egress.

## Deployment paths

The software stack is 100% open-source. **Hosting** has cost trade-offs. Three honest paths, pick by phase.

### Path A — Fully self-hosted ($0/mo + electricity)

Run the entire stack on the powerful Windows + WSL2 box used for development. Cloudflare Tunnel exposes it to the internet as `copilot.thisisgravitas.com`.

```
┌─ Windows + WSL2 (your box) ─────────────┐
│  Next.js app                            │
│  Crawl worker (Playwright)              │
│  Ollama (DeepSeek-R1, Qwen3, embed)     │
│  ChromaDB (Docker)                      │     Cloudflare Tunnel
│                                         │  ◄─────────────────────►  internet
└─────────────────────────────────────────┘

Supabase free tier (cloud)  ───  auth, postgres, log tables
Anthropic Claude API        ───  $50/day cap
```

**When to use:** dev, Phase 0–1 internal demos, early Gravitas-leadership previews.

**Limitations:** home internet uptime, single point of failure (the box), not for customer traffic on a real domain.

### Path B — Free-tier cloud (with real caveats)

| Component | Free tier | Caveat |
|---|---|---|
| Next.js app | Vercel Hobby | **Hobby ToS is non-commercial only.** For `thisisgravitas.com` customer traffic this violates terms. |
| Crawl worker | Render free web service | 750h/mo, **sleeps after 15 min idle** → ~30s cold start for the first audit after sleep |
| Supabase | Free tier | 500MB DB, **pauses after 7 days inactivity**, 2GB egress/mo |
| Ollama in production | No good free option. Choices: tunnel to home box (works, latency), Groq free tier (rate-limited, model selection limited), Cloudflare Workers AI free (very limited) |
| ChromaDB | Render free or fly.io paid | Same cold-start caveat on Render |
| Claude API | — | $50/day cap, paid |

**When to use:** never for production thisisgravitas.com traffic. Possibly OK for an isolated proof-of-concept under a different domain.

### Path C — Railway (production) — **recommended**

The user has a paid Railway account, which makes Railway the right choice: it can host the Next.js app, the crawl worker, ChromaDB, and the cron service in **one project** with private networking between services. Vercel can't host the worker; Fly.io is no longer free. Railway collapses three services into one platform.

```
┌─ Railway project (one $5/mo subscription, $10/mo included usage) ──┐
│                                                                    │
│   ┌─────────────┐   ┌────────────┐   ┌──────────┐   ┌─────────┐    │
│   │  next-app   │   │   crawl    │   │  chroma  │   │  cron   │    │
│   │  (Next.js)  │◄─►│ (Playwright│◄─►│ (Docker, │   │ (KB     │    │
│   │             │   │  Lighthouse│   │  volume) │   │  refresh│    │
│   │             │   │  Cheerio)  │   │          │   │  04 UTC)│    │
│   └─────────────┘   └────────────┘   └──────────┘   └─────────┘    │
│         ▲                                                          │
│         │     Railway internal networking + shared env vars        │
└─────────┼──────────────────────────────────────────────────────────┘
          │
          │ Cloudflare DNS + DDoS proxy (free)
          ▼
   copilot.thisisgravitas.com
          │
          │ Cloudflare Tunnel (free)
          ▼
   ┌─ Home Windows box ────────────────────┐
   │  Ollama (DeepSeek-R1, Qwen3, embed)   │
   └───────────────────────────────────────┘

External:
  Supabase free tier — auth, postgres, log tables
  Anthropic Claude API — $50/day cap
```

| Component | Service | Cost |
|---|---|---|
| Next.js app | **Railway service** | Covered by base Railway subscription |
| Crawl worker | **Railway service** (same project) | Covered |
| ChromaDB | **Railway service** with persistent volume | Covered |
| Cron — KB refresh | **Railway cron service** OR `railway.cron` config | Covered |
| Railway subscription + usage | $5/mo subscription + $10/mo included credits + pay-as-you-go | Likely **$5–15/mo** for moderate traffic |
| Supabase | Free tier | $0 — upgrade to Pro ($25/mo) only when limits hit |
| Ollama | **Home Windows box** via Cloudflare Tunnel | $0 — you already have it on |
| Cloudflare (DNS, proxy, Tunnel, SSL) | Free tier | $0 — sufficient, no upgrade needed |
| Claude API | Anthropic | $50/day cap (≤ $1,500/mo absolute worst case) |

**When to use:** the day the Co-Pilot embeds on thisisgravitas.com for real customer traffic.

**Railway-specific notes**

- All four services live in one Railway project. Use Railway's "Private Networking" feature so `crawl` and `chroma` are not exposed to the public internet — only `next-app` is.
- ChromaDB needs a **persistent volume** in Railway. Attach a 1GB volume to the chroma service; without it, the vector index resets on every redeploy.
- `next-app` is the only service with a public domain. Custom domain (`copilot.thisisgravitas.com`) is set up in Railway, then DNS pointed via Cloudflare.
- Use Railway environment variable groups: one shared group for keys (Anthropic, Supabase) referenced by all four services.
- Health checks: each service exposes `/health` that Railway pings. The `next-app` health check should not run the agent; it just returns 200.
- Deployments: GitHub integration; on push to `main`, Railway rebuilds and rolls out. Each service builds independently.

**Alternative (documented but not chosen):** Vercel Pro ($20/mo) for the Next.js app + Fly.io shared-cpu-1x (~$2/mo) for the worker + a separate Fly machine for Chroma. Functionally equivalent; just more moving parts and a higher floor cost.

**Optional upgrade — cloud Ollama:** if you ever want the home box out of the critical path, rent a small GPU pod (RunPod Spot, ~$20–40/mo for intermittent use). Not required for Phase 1–2; the home box via Cloudflare Tunnel works well.

### Recommendation by phase

| Milestone | Recommended path | Rationale |
|---|---|---|
| M1–M5 (build + internal demo) | **Path A** (self-host on Windows box) | Free, fast, the box is already set up; Cloudflare Tunnel exposes it for stakeholder previews |
| M6 (production cutover on thisisgravitas.com) | **Path C — Railway** | Single project hosts app + worker + Chroma + cron; covered by the existing paid Railway account |

### What we are NOT trying to make free

- **Anthropic Claude API** — paid by design, capped at $50/day. The cap is the answer.
- **Domain DNS** — Cloudflare free is sufficient. No paid Cloudflare plan needed.

### Cost ceiling at full production (Path C — Railway)

| Line | Realistic | Worst case |
|---|---|---|
| Railway subscription + usage (one project, four services) | $5–15/mo | up to ~$30/mo on heavy traffic |
| Supabase | $0 | $25/mo (Pro, only when limits hit) |
| Cloudflare | $0 | $0 |
| Ollama (home box) | $0 + electricity | $0 + electricity |
| Claude API | varies | **$50/day × 30 = $1,500/mo absolute ceiling** |
| **Realistic monthly burn** | **~$5–50/mo** + Claude usage | |
| **Absolute worst case** | | **~$1,555/mo** |

The realistic burn is dominated by Claude actual usage, not infrastructure. Infrastructure rounds to ≤ $30/mo even at heavy load.

## Embedding on thisisgravitas.com

The Co-Pilot's canonical home is `https://ai.thisisgravitas.com`. It's also surfaced on the main marketing site (`thisisgravitas.com`) via a **floating launcher pill** that opens a **full-screen takeover** iframe.

### Why a takeover, not a chat panel

A traditional 400×600px chat panel can't render the Generative Canvas. The takeover gives the dual-pane experience full viewport room while still being launched from anywhere on the marketing site. The launcher pill is text-led ("Co-Pilot ↗") with Gravitas branding — **not** a chat-bubble icon. This distinction is what separates "Gravitas Co-Pilot" from "another agency chatbot."

### Integration on the marketing site

One line of HTML, served from the subdomain:

```html
<script src="https://ai.thisisgravitas.com/widget.js" defer></script>
```

That's the only change to thisisgravitas.com. The launcher script is hosted by the same Next.js app on the subdomain — single source of truth.

### Topology

```
thisisgravitas.com                       ai.thisisgravitas.com  (Railway)
─────────────────────                    ────────────────────────────────
<script defer src="…/widget.js">  ◄────  /widget.js   (< 5KB, no deps)
                                              │
inject <button>"Co-Pilot ↗"                   │
        │                                     │
        └─ click → full-screen overlay        │
                  with <iframe>     ────────► /copilot?embed=takeover
                        ▲                          │
                        │   postMessage bridge      │
                        │   (origin-verified) ─────┤
                        ▼                          │
                  {type:"close"} ──► overlay teardown
```

### The launcher script (`public/widget.js`)

Delivered from the Next.js public folder. Constraints:

- **< 5 KB gzipped**, zero external dependencies (no React, no bundler runtime — vanilla TS compiled to a single IIFE)
- `defer` on the `<script>` tag so it never blocks the marketing site's LCP
- No preload of the iframe — fetch only on first click
- Reads `<script data-position="bottom-left">` for position override (default: bottom-right)
- Reads `<script data-page="services">` (optional) so analytics know which marketing page launched the session
- Injects styled DOM into a Shadow DOM root to avoid CSS conflicts with the marketing site
- Handles: button render, click → overlay open, ESC / X / outside-click → close, mobile responsive collapse
- Logo: inline from `GRAVITAS_LOGO_DATA_URI` (no external fetch)

The script never communicates with Anthropic, Supabase, or Ollama directly. All API calls happen inside the iframe context.

### Embed mode (`?embed=takeover`)

The `/copilot` route accepts an `embed` query param. When present:

- Renders edge-to-edge (no marketing chrome, no nav, no footer — just the dual-pane)
- Disables in-app links that would navigate away from the embed
- Sends `{type: "ready"}` on mount via `postMessage` to the parent
- Sends `{type: "close"}` when the visitor clicks the in-app close affordance
- Shows a small "Open in new tab ↗" link that opens the canonical `https://ai.thisisgravitas.com/copilot` (preserves shareability)

`embed=takeover` is the only currently-defined value, but the param is enum-shaped so we can add `embed=panel` (cramped 400px mode) later if a partner site needs it.

### `postMessage` protocol — typed and origin-verified

A typed protocol between widget.js (parent) and the iframe (subdomain). Both sides verify `event.origin` against the strict allowlist:

```ts
const ALLOWED_PARENT_ORIGINS = ["https://thisisgravitas.com", "https://www.thisisgravitas.com"];
const ALLOWED_FRAME_ORIGIN   = "https://ai.thisisgravitas.com";

type ParentToFrame =
  | { type: "open", parentUrl: string, parentReferrer: string };

type FrameToParent =
  | { type: "ready" }
  | { type: "close" }
  | { type: "resize", height: number }    // reserved for non-takeover modes
  | { type: "telemetry", event: string };  // optional, for parent-side analytics
```

Schemas live in `src/widget/protocol.ts` and are zod-validated on both sides. Any message that fails validation is dropped and logged. **Never** trust an unverified `postMessage` event.

### Cookies and session

- Visitor session state (session ID, IP-hash quota, etc.) is scoped to `ai.thisisgravitas.com` cookies — never leaks to the parent domain.
- The launcher never sets cookies on `thisisgravitas.com`.
- Admin auth cookies (Supabase, for `/admin/*`) also stay on the subdomain.

### Privacy

A short notice in the takeover overlay footer (visible without scrolling): *"Conversations are logged for quality."*

This is required because the takeover is on `ai.thisisgravitas.com` and the visitor's expectation may be that they're still on the marketing site. Make the boundary clear.

### CSP heads-up for thisisgravitas.com

If the marketing site uses a Content Security Policy, two directives need updates:

- `script-src` must allow `https://ai.thisisgravitas.com` (for `widget.js`)
- `frame-src` (or `child-src`) must allow `https://ai.thisisgravitas.com` (for the iframe)

Coordinate with whoever owns the marketing-site infrastructure before going live.

## Security

- The crawl worker requires a shared secret on every request (`CRAWL_WORKER_SHARED_SECRET`). The Next.js app sends it; the worker rejects requests without it.
- Visitor URLs are sanitized before being passed to Playwright. We reject:
  - Non-`http(s)` schemes
  - RFC1918 / loopback / link-local addresses (no SSRF)
  - URLs > 2KB
- Visitor input is never interpolated into a tool argument as a string; tools receive validated zod-parsed payloads only.
- No PII is logged. Lead form fields are stored encrypted at rest in Supabase.

## What this architecture explicitly defers

- Multi-region deployment (single region is fine until traffic forces it)
- A real queue between the app and the worker (HTTP is fine; add a queue when crawl latency or worker failures justify it)
- Custom auth (Supabase Auth handles everything we need for Phase 1)
- Self-hosted vector store at scale (Chroma local is fine throughout Phase 1)
