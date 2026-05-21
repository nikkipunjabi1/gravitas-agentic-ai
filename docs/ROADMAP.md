# Roadmap

Phased delivery. Claude Code does not start a phase until the previous one's Definition of Done is signed off.

The currently active phase is marked **IN PROGRESS**.

---

## Phase 0 — Foundation **IN PROGRESS**

Scaffolding and shared infrastructure. No agent intelligence yet — wire it up end-to-end so each subsequent piece slots in.

**Deliverables**

- Next.js app scaffolded (App Router, Tailwind, shadcn/ui, TypeScript strict)
- `/copilot` route with the empty dual-pane layout (left: chat shell, right: canvas shell)
- Streaming chat endpoint that echoes the user message back via the Vercel AI SDK
- Model router (`src/lib/models/`) with two providers wired and smoke-tested:
  - Ollama (DeepSeek-R1 or Qwen3) — local
  - Anthropic Claude Sonnet 4.6 — via API key in `.env.local`
- Crawl worker scaffold (`worker/`) — accepts a URL, returns a stub JSON payload
- `UIAction` zod schema defined per `docs/UI_CONTRACT.md`, plus one trivial test component (`<DebugAction>`) that renders the payload as JSON
- `.env.example` enumerating every required variable
- README + CLAUDE.md commands section filled in
- Lint, typecheck, and a smoke Playwright test pass in CI

**Definition of Done**

- `pnpm dev` boots the app, `pnpm dev:worker` boots the crawl worker
- User types into chat → message round-trips through the model router → response streams back
- Sending the keyword `debug` from the agent emits a `UIAction` that renders in the canvas
- All `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` green

---

## Phase 1 — MVP: AI Experience Auditor

The "wow" demo. Paste a URL, get a real audit in the canvas, in under 30 seconds.

**Scope**

- **Discovery (lightweight):** one or two questions to capture industry + role + the named problem
- **URL audit (one page, exactly):**
  - Worker runs Playwright + Lighthouse + Cheerio against **only** the URL the visitor submitted — no link-following, no sibling-page crawling
  - Extracts: page speed (LCP/FCP/TTFB/CLS), accessibility (contrast, touch targets, alt text, ARIA), content architecture signals, design consistency signals (button variants, spacing, icon sizes), AI-readiness signals (structured data, semantic markup, indexability), mobile experience signals
- **Canvas components rendered as findings arrive, mapped to the Four-Lens framework (see `docs/BRANDING.md`):**
  1. `AuditFindings` — findings tagged with `lens` (usability / user-needs / conversion / design-execution) and severity
  2. `MaturityChart` — 4-axis radar (D1 Usability Standards / D2 User Needs / D3 Conversion / D4 Design Execution), each with raw + normalized scores; total /100 with optional post-engagement target
  3. `RoadmapWidget` — `mode: "priority"` with Must / Should / Could grouping
  4. `KeepAndBuildOn` — positive findings, rendered before critique (Gravitas methodology)
  5. `ThemesGrid` — 4–6 cross-cutting themes that span lenses
- **Solution mapping:** each finding tagged with the Gravitas service it maps to
- **Hybrid model routing:** DeepSeek-R1 for reasoning over the audit JSON; Claude Sonnet for the user-facing narration in chat and the copy inside each canvas component
- **Daily cost cap ($50 default) with graceful degradation:** centralized in `src/lib/models/router.ts`. Every Claude call is tagged `voice-light` or `voice-heavy`. Pre-flight estimate against the Supabase `cost_ledger` table; reconciles actuals after each call. When cap is hit: `voice-heavy` throws `DailyCapExceeded` → graph routes to `CapReached` terminal node → `DailyCapReached` UIAction + waitlist email capture. `voice-light` silently swaps to Ollama (Qwen3) so KB-grounded answers keep working — site never goes fully dark. Email *sending* is deferred to Phase 2; Phase 1 only captures.
- **Per-IP rate limiting:** independent of the cost cap. Defaults: 20 chat turns / IP / day, 1 URL audit / IP / day (via `IP_DAILY_TURN_LIMIT` and `IP_DAILY_AUDIT_LIMIT`). `src/lib/quota/ip-quota.ts` enforces in `/api/chat` before the agent runs and in the Audit node before crawl. Quota counter visible in UI only when ≤ `COUNTER_VISIBLE_THRESHOLD` (default 5) turns remain. Exhaustion → `RateLimitReached` UIAction. IP stored only as `sha256(ip + SESSION_SIGNING_SECRET)` in the `ip_quota` table.
- **Branding embedded:** `pnpm branding:fetch` runs once at scaffold, downloads the Gravitas logo SVG, embeds it as a base64 data URI in `src/lib/branding/logo.ts`. Every canvas component, the audit report, and the daily-cap card display the logo. No runtime fetch from the asset host.
- **Audit report follows the Gravitas template** (`docs/BRANDING.md`): Four-Lens framework, scoring rubric (raw + normalized), Keep & Build On positive framing before critique, Must/Should/Could prioritisation, calibrated scoring (most pages should land "Developing"), the "About this audit" honesty footer that distinguishes the auto-audit from a full Gravitas engagement, bilingual "Shukran! / شكراً" closing with the named contact from `BRANDING_CLOSING_CONTACT_*` env vars. Phase 1 = canvas-rendered sections only. PDF generation = Phase 3.
- **Admin panel (minimal):** `/admin/*` routes behind Supabase magic-link auth restricted to `@thisisgravitas.com`. Phase 1 includes: Dashboard tile-strip (today's spend, sessions, blocked calls, leads, health dots), Sessions table with filters, Session detail with full transcript + inline model/tool/UIAction events, Visitor queries raw list, Health page. Tremor for tiles/sparkline. **Read-only.** Logging chokepoints in `src/lib/models/router.ts` and `src/lib/stream/ui-action.ts` populate `sessions`, `messages`, `model_calls`, `ui_actions_emitted`. Nightly retention cron deletes rows older than `SESSION_RETENTION_DAYS` (default 90). See `docs/ADMIN_PANEL.md` for full spec.
- **Marketing-site embedding:** the Co-Pilot ships as a floating launcher pill on `thisisgravitas.com` that opens the experience as a full-screen takeover iframe. One-line integration on the marketing site (`<script src="https://ai.thisisgravitas.com/widget.js" defer>`), all delivery from the subdomain. Launcher script < 5KB gzipped, vanilla TS in a Shadow DOM root, zero external deps. Embed-mode route `/copilot?embed=takeover` renders edge-to-edge with an "Open in new tab" affordance to the canonical URL. Typed origin-verified `postMessage` bridge (`src/widget/protocol.ts`) handles open/close/telemetry. See `docs/ARCHITECTURE.md` → Embedding on thisisgravitas.com.

- **Gravitas KB ingest pipeline (Phase 1):**
  - Initial seed via `pnpm kb:reseed` of the whitelist (`/`, `/about`, `/services/*`, `/work/*`, `/insights/*`) into the ChromaDB `gravitas-kb` collection.
  - **Scheduled daily incremental refresh** — Railway Cron (or equivalent in dev: a node-cron service in the same Next.js process) hits `worker/kb/refresh` at 04:00 UTC. Job fetches `sitemap.xml`, diffs `lastmod` + content hash against the `kb_documents` table in Supabase, re-embeds **only changed pages**.
  - Discovery answers `gravitas-question` intent from this KB starting day one.
  - `pnpm kb:reseed` remains available for forced full re-crawl after embedding-model or schema changes.

**Out of scope (deferred to Phase 2)**

- Multi-turn discovery beyond the opening questions
- Executive brief PDF
- Lead capture form
- Persistent sessions

**Definition of Done**

- A first-time visitor with no instructions can: paste a URL, watch the canvas populate, and end the session understanding what's wrong and what Gravitas would do
- Median time from URL submission to first canvas render: ≤ 8 seconds
- Median audit completion: ≤ 30 seconds
- Three Gravitas strategists review three real sessions each and rate the agent's analysis ≥ 4/5 on accuracy and ≥ 4/5 on voice
- **Cost cap proof (heavy):** a simulated "spend $49.50 of $50" test triggers `DailyCapReached` on the next `voice-heavy` request; the waitlist row is written; no further Anthropic calls are made for heavy purposes until the next reset
- **Lite-mode proof (light):** with the cap exceeded, a visitor asking "what does Gravitas do?" still gets a KB-grounded answer; the `model_calls` row shows `provider = ollama`, `purpose = voice-light-degraded`; the admin dashboard shows `lite_mode_substitutions > 0`
- **Rate-limit proof:** the 21st turn from a single IP returns `RateLimitReached`; the 2nd audit from the same IP same day returns `RateLimitReached` with `reason = "audits"`; counter appears in UI when 5 turns remain
- **Branding proof:** the Gravitas logo renders on every canvas surface and in the daily-cap card, sourced exclusively from `GRAVITAS_LOGO_DATA_URI`; blocking outbound traffic to `assets.thisisgravitas.com` at test time does not affect rendering
- **Admin panel proof:** a `@thisisgravitas.com` user signs in via magic link and sees today's session in the dashboard within 30s of it ending; a non-Gravitas email is refused at the database trigger; the simulated cap-hit session shows `was_blocked = true` in the `/admin/sessions/[id]` model-call list
- **Embedding proof:** a test HTML page with `<script src="https://ai.thisisgravitas.com/widget.js" defer>` renders the launcher pill in < 100ms after page load; clicking it opens the full-screen takeover with `ready` postMessage received within 1s; ESC + X both close cleanly via `close` postMessage; `widget.js` is ≤ 5KB gzipped and ships zero CSS leaks (verified by rendering inside a styled parent page); `event.origin` mismatches are dropped (verified by sending a forged postMessage from a malicious origin in a test)

---

## Phase 2 — Multi-agent Transformation Co-Pilot

Move from one-shot audit to genuine multi-agent reasoning.

**Scope**

- Full LangGraph state machine with five nodes: Discovery, Audit, Strategy, Solution Mapping, Output (see `docs/AGENTS.md`)
- Discovery agent properly sequences follow-ups based on the visitor's answers
- Strategy agent generates a roadmap that synthesizes Discovery + Audit
- Three additional canvas components:
  4. `SolutionMap` — visitor problems linked to Gravitas services with rationale
  5. `TechStackReco` — when the conversation surfaces tech debt or modernization
  6. `LeadGenForm` — typed schema, posts to Supabase
- Persistent session (Supabase) so a visitor returning within 24h can resume
- Strategy agent grounds recommendations in the KB; cites case studies (e.g. ADCB AI Knowledge Base) when relevant. (KB refresh pipeline itself lives in Phase 1; Phase 2 just leans on it from a new node.)
- **Admin panel (full):** Usage & Cost charts (daily spend, by model, by purpose, by node, per-session histogram, top expensive sessions); KB panel with run history; Waitlist management; topic clustering of visitor queries (Ollama-powered nightly job); CSV export; gated actions (manual KB reseed, raise cap for the day, send "we're back" email)
- **Curated Answers — admin-authored knowledge layered on the auto-crawled KB:** new admin route `/admin/answers` with full CRUD editor (title, Markdown body, tags, optional exact-match trigger phrases, weight 1.0–5.0, status). Save → embeds via Ollama → upserts to a separate `gravitas-curated` Chroma collection. The agent's `kb_search` tool becomes hybrid — queries both `gravitas-kb` and `gravitas-curated`, merges, applies each curated answer's weight (default 1.5×). High-value workflow: from `/admin/queries` topic clusters, "Create curated answer for this topic" pre-fills the editor with the topic label and sample messages. See `docs/ADMIN_PANEL.md` → Curated Answers.

**Definition of Done**

- A session can run end-to-end without a URL (pure-discovery mode) and still produce a credible roadmap
- The Strategy agent cites at least one Gravitas case study or service when relevant
- ≥ 5% of completed sessions submit the lead form

---

## Phase 3 — Autonomous Co-Pilot + Industry modes

Push the agent into genuine autonomy, with guardrails.

**Scope**

- `ExecutiveBriefDownload` — agent generates a **6–10 page PDF audit report** following the full Gravitas template from `docs/BRANDING.md` (Cover, The Brief, Four Lenses, Executive Summary, Keep & Build On, four lens deep-dives, Cross-Cutting Themes, Must/Should/Could recommendations, Technical Health, Solution Mapping, Suggested Next Step, "About this audit" honesty block, "Shukran!" closing). Includes an annotated screenshot of the audited page captured by the crawl worker. PDF generator at `src/server/pdf/audit-report.ts`.
- Industry-specific modes (Banking, Government, Retail, Healthcare) — each tunes Discovery questions and Solution Map language
- Optional: live website re-analysis when the visitor mentions a different page
- Reviewer queue: Gravitas team can sample sessions and flag bad outputs; flags feed eval set
- Eval harness (golden conversations + LLM-as-judge) to catch regressions
- **Admin panel — alerts and digests:** Slack/email when blocked calls > 0, when daily spend > 80% of cap, or when KB ingest fails; daily digest email summarizing the previous day; eval-results panel

**Definition of Done**

- A visitor can request the PDF and receive it within 60s
- Industry mode is auto-detected from the visitor's first message ≥ 70% of the time
- A weekly eval run catches any regression > 5% on the golden set

---

## Backlog (not scheduled)

- Multilingual (Arabic priority given Gravitas's Gulf client base)
- Voice input
- Embedded onto specific Gravitas service pages with pre-filled context
- A/B test of canvas-first vs. chat-first openings
- CRM integration (HubSpot / Salesforce)
- Authenticated dashboards for returning enterprise leads
- Proposal generation (gated by a human reviewer regardless of phase)

## Success metrics (tracked from Phase 1 onwards)

| Metric | Target by end of Phase 2 |
|---|---|
| Session reaches canvas | ≥ 40% |
| Audit flow completes | ≥ 15% |
| Lead form submitted | ≥ 5% |
| Median session length | ≥ 3 min |
| Time to first canvas render | < 8s |
| Strategist voice rating (sampled) | ≥ 4/5 |

## How phases are signed off

The user (Nikki) explicitly confirms a phase is done. Claude Code does not self-promote a phase.
