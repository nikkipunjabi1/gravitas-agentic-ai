# Roadmap

## Status: live pilot

Phase 1 (M1–M6) is **shipped**. The product is running from a local laptop served via `ai.thisisgravitas.com` (Cloudflare Tunnel) and is being iterated as discrete `P1.N` polish batches in response to live-pilot feedback.

**Latest shipped**: P1.17 (ChromaDB → Supabase pgvector + chunks viewer at `/admin/kb/chunks`).

Scroll to the "Post-M6 polish (P1.11+)" section below for the running list of post-milestone work. The M1–M6 sections that follow are kept as historical reference.

---

## Phase 1 — Gravitas Transformation Co-Pilot (shipped)

Full scope. No deferral. Six internal milestones (M1–M6) provided build cadence — they prevented the "3-month black box with nothing demo-able" failure mode without re-introducing phasing.

---

### M1 — Foundation **✅ shipped**

Scaffolding and shared infrastructure. No agent intelligence yet — wire the framework so the rest slots in.

**Deliverables**

- Next.js app scaffolded (App Router, Tailwind, shadcn/ui, TypeScript strict)
- Required polish stack installed and wired: Framer Motion + GSAP + Lenis + next-themes + Vaul + Sonner; Aceternity UI patterns folder seeded with at least `AuroraBackground` and `MovingBorder`
- Dark-mode-only theme provider; brand colour tokens in `tailwind.config.ts` per `docs/BRANDING.md`
- `next/font` configured with `Inter` as the temporary brand-font fallback
- `/copilot` route with the empty dual-pane layout (left: chat shell, right: canvas shell)
- Lenis smooth scroll mounted at root
- Streaming chat endpoint that echoes the user message back via the Vercel AI SDK
- Model router (`src/lib/models/`) with two providers wired and smoke-tested: Ollama and Anthropic
- Crawl worker scaffold (`worker/`) — accepts a URL, returns a stub JSON payload
- Logo fetch script (`pnpm branding:fetch`) populates `src/lib/branding/logo.ts` with the base64 data URI
- `UIAction` zod schema defined per `docs/UI_CONTRACT.md`, plus one trivial test component (`<DebugAction>`) that renders the payload as JSON
- Widget launcher skeleton (`public/widget.js`) — renders the launcher pill, opens an empty takeover iframe; postMessage round-trip works
- `.env.example` enumerating every required variable
- Lint, typecheck, smoke Playwright test pass in CI (GitHub Actions)

**Demo-able state**

- `pnpm dev` boots the Next.js app; `pnpm dev:worker` boots the crawl worker
- User types into chat → message round-trips through the model router → response streams back
- Sending the keyword `debug` from the agent emits a `UIAction` that renders in the canvas
- Widget launcher on a test HTML page opens the takeover iframe correctly
- All `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` green

---

### M2 — Auditor + KB ingest + Cost cap + Rate limit + Minimal admin **✅ shipped**

The first end-to-end "wow" demo: visitor pastes a URL → audit appears in the canvas in < 30s. All the operational guards in place from day one.

**Deliverables**

- **Discovery (lightweight):** one or two questions to capture industry + role + named problem (single-pass; multi-turn refinement is M3)
- **URL audit (one page, exactly):**
  - Worker runs Playwright + Lighthouse + Cheerio against the URL the visitor submitted — no link-following
  - Extracts: page speed (LCP/FCP/TTFB/CLS), accessibility, content architecture, design consistency, AI-readiness, mobile experience
- **Five canvas components**, mapped to the Four-Lens framework (see `docs/BRANDING.md`):
  1. `AuditFindings` — findings tagged with `lens` and severity
  2. `MaturityChart` — 4-axis radar with raw + normalized scores, total /100
  3. `RoadmapWidget` — `mode: "priority"` Must / Should / Could grouping
  4. `KeepAndBuildOn` — positive findings, rendered before critique
  5. `ThemesGrid` — 4–6 cross-cutting themes
- **Hybrid model routing:** DeepSeek-R1 (Ollama) for reasoning over the audit JSON; Claude Sonnet for `voice-light` and `voice-heavy` narration
- **Daily cost cap ($50 default) with graceful degradation:** centralized in `src/lib/models/router.ts`. `voice-heavy` throws `DailyCapExceeded` → `CapReached` terminal node → `DailyCapReached` UIAction + waitlist email capture. `voice-light` silently swaps to Ollama (Qwen3) — lite mode. Site never goes fully dark.
- **Per-IP rate limiting:** 20 chat turns + 1 audit / IP / day (env-configurable). UI counter visible when ≤ 5 turns remain. Exhaustion → `RateLimitReached` UIAction. IP stored only as `sha256(ip + SESSION_SIGNING_SECRET)`.
- **Branding embedded:** logo data URI from M1 is referenced by every canvas component, the audit report sections, the daily-cap card, and the rate-limit card. No runtime fetch from the asset host.
- **Audit report follows the Gravitas template** (`docs/BRANDING.md`): Four-Lens framework, scoring rubric, Keep & Build On before critique, Must/Should/Could prioritisation, calibrated scoring (most pages should land "Developing"), the "About this audit" honesty footer, bilingual "Shukran! / شكراً" closing with named contact from `BRANDING_CLOSING_CONTACT_*` env vars. Canvas-rendered sections only — PDF generation is M5.
- **Minimal admin panel** at `/admin/*` behind Supabase magic-link auth restricted to `@thisisgravitas.com`:
  - Dashboard tile-strip (today's spend, sessions, blocked calls, lite-mode answers, rate-limited IPs, leads, health dots)
  - Sessions table with filters
  - Session detail with full transcript + inline model/tool/UIAction events
  - Visitor queries raw list
  - Health page
  - **Read-only** in M2. Gated write actions arrive in M4.
- **Logging chokepoints** populated by `src/lib/models/router.ts` and `src/lib/stream/ui-action.ts`: `sessions`, `messages`, `model_calls`, `ui_actions_emitted`. Nightly retention cron deletes rows older than `SESSION_RETENTION_DAYS` (90 default).
- **Marketing-site embedding:** the launcher pill on thisisgravitas.com opens the full-screen takeover iframe. Launcher script < 5KB gzipped, vanilla TS in Shadow DOM, zero deps. Typed origin-verified postMessage bridge.
- **Gravitas KB ingest pipeline:**
  - Initial seed via `pnpm kb:reseed` of the whitelist (`/`, `/about`, `/services/*`, `/work/*`, `/insights/*`) into the ChromaDB `gravitas-kb` collection
  - **Scheduled daily incremental refresh** — Railway Cron (or `node-cron` in dev) hits `worker/kb/refresh` at 04:00 UTC. Sitemap-diffed, content-hashed; only changed pages re-embed.
  - Discovery answers `gravitas-question` intent from this KB starting day one
  - `pnpm kb:reseed` available for forced full re-crawl

**Demo-able state**

- A first-time visitor pastes a URL, watches the canvas populate, and ends the session understanding what's wrong and what Gravitas would do
- Median time from URL submission to first canvas render: ≤ 8s
- Median audit completion: ≤ 30s
- Three Gravitas strategists review three real sessions each, rate ≥ 4/5 on accuracy and ≥ 4/5 on voice
- **Cost cap proof (heavy):** simulated "spend $49.50 of $50" → next `voice-heavy` request returns `DailyCapReached`, waitlist row written, no further Anthropic heavy calls until reset
- **Lite-mode proof (light):** with cap exceeded, "what does Gravitas do?" returns a KB-grounded answer; `model_calls` shows `provider=ollama`, `purpose=voice-light-degraded`; admin dashboard `lite_mode_substitutions > 0`
- **Rate-limit proof:** 21st turn from one IP → `RateLimitReached`; 2nd audit from same IP same day → `RateLimitReached` `reason="audits"`; counter visible at 5 remaining
- **Branding proof:** logo renders on every canvas surface from `GRAVITAS_LOGO_DATA_URI`; blocking `assets.thisisgravitas.com` at test time does not affect rendering
- **Admin proof:** `@thisisgravitas.com` user signs in via magic link and sees today's session within 30s of completion; non-Gravitas email refused at the DB trigger; cap-hit session shows `was_blocked=true`
- **Embedding proof:** test HTML page with the widget script renders the launcher pill in < 100ms; click opens takeover with `ready` postMessage within 1s; ESC + X close via `close` postMessage; widget.js ≤ 5KB gzipped, zero CSS leaks; forged origins dropped

---

### M3 — Full multi-agent graph + Strategy grounding + Persistent sessions **✅ shipped**

Move from one-shot audit to genuine multi-agent reasoning. The graph nodes shift from sequential pass-through to properly orchestrated state.

**Deliverables**

- Full LangGraph state machine with five nodes (see `docs/AGENTS.md`): Discovery, Audit, Strategy, Solution Mapping, Output — plus the global fallback edge to `CapReached`
- Discovery agent properly sequences follow-ups based on the visitor's answers (multi-turn, intent-routed)
- Strategy agent generates a roadmap that synthesizes Discovery + Audit, grounded in the Gravitas KB; cites case studies (e.g. ADCB AI Knowledge Base) when relevant
- Solution Mapping produces visitor-phrase → Gravitas-service mappings with rationale
- Three additional canvas components:
  6. `SolutionMap` — visitor problems linked to Gravitas services with rationale and optional case-study reference
  7. `TechStackReco` — when the conversation surfaces tech debt or modernization
  8. `LeadGenForm` — typed schema, posts to Supabase
- Persistent sessions in Supabase: visitor returning within 24h can resume

**Demo-able state**

- A session can run end-to-end **without** a URL (pure-discovery mode) and still produce a credible roadmap
- The Strategy agent cites at least one Gravitas case study or service when relevant
- ≥ 5% of completed sessions submit the `LeadGenForm`

---

### M4 — Curated Answers + Full Admin Panel **partially shipped**

Admin panel + KB controls landed (P1.6 / P1.7 / P1.8 / P1.13–P1.17). Curated Answers (admin-authored knowledge layered on the auto-crawled KB) is **NOT yet built** — see Backlog. The non-curated parts of M4 — `/admin/cost`, `/admin/kb` with run history, `/admin/queries`, `/admin/settings`, gated write actions, CSV export (partial) — are all in.

**Deliverables**

- **Curated Answers** — see `docs/ADMIN_PANEL.md` for full spec:
  - `/admin/answers` CRUD editor (Markdown body, tags, trigger phrases, weight 1.0–5.0, status)
  - `curated_answers` table in Supabase
  - `gravitas-curated` Chroma collection (separate from `gravitas-kb`)
  - On save: row written → Ollama embeds → upserts to Chroma → "indexed at HH:MM" indicator
  - **Hybrid `kb_search`** queries both collections, merges, applies the per-row weight multiplier; trigger phrases override
- **Full Admin Panel:**
  - `/admin/cost` — daily spend charts; by model / purpose / agent node; per-session cost histogram; top 10 expensive sessions
  - `/admin/kb` — last ingest run, 30-day history, index size, recent crawl errors; gated "reseed now" button
  - `/admin/waitlist` — captured cap-reached emails with status; gated "send 'we're back' email" button (requires email infra — Resend or Supabase Auth transactional)
  - `/admin/queries` (upgrade) — topic clusters from a nightly Ollama job; "Create curated answer for this topic" button pre-fills the editor
  - `/admin/settings` — cap value override (gated, time-limited), retention, alert recipients
  - CSV export across tables
  - Session replay (re-emit UIActions into an embedded canvas)
- `tool_calls` Supabase table populated by the tool wrappers
- Role split: `viewer` vs `admin` for gated write actions

**Demo-able state**

- Admin writes a curated answer; visitor asks a semantically close question within minutes; the agent's response cites the curated content; the session transcript marks the assistant message with "via curated answer: [title]"
- Admin dashboard shows the full set of charts; clicking through a topic cluster reveals the sessions in that cluster
- A "send 'we're back' email" trigger from `/admin/waitlist` delivers the email and updates the `notified_at` timestamp
- Gated KB reseed runs successfully and is logged

---

### M5 — Executive Brief PDF + Industry modes **partially shipped**

Print-to-PDF from the canvas (`window.print()` with a print stylesheet) shipped in P1.10 instead of a full server-generated PDF. Industry modes are still in code as a Phase-2 follow-up — see Backlog.

**Deliverables**

- **`ExecutiveBriefDownload` PDF** — a 6–10 page audit report following the full Gravitas template from `docs/BRANDING.md`:
  - Cover, The Brief, Four Lenses, Executive Summary
  - Keep & Build On, four lens deep-dives, Cross-Cutting Themes
  - Must/Should/Could recommendations
  - Technical Health
  - Solution Mapping
  - Suggested Next Step
  - "About this audit" honesty block
  - "Shukran!" closing with named contact
  - Includes an annotated screenshot of the audited page (captured by the crawl worker at mobile + desktop viewports)
- PDF generator at `src/server/pdf/audit-report.ts` (e.g. via React-PDF or Puppeteer)
- **Industry-specific modes** (Banking, Government, Retail, Healthcare) — each tunes Discovery questions and Solution Map language. Auto-detected from the visitor's first message; manual override possible
- Optional: live website re-analysis when the visitor mentions a different page (still capped at `IP_DAILY_AUDIT_LIMIT`)

**Demo-able state**

- A visitor completes a session and requests the PDF; it's delivered within 60s, signed URL valid for 7 days
- Industry mode is auto-detected from the visitor's first message ≥ 70% of the time
- Each industry mode's Solution Map language is verifiably different (e.g. Banking surfaces "compliance" and "regulator" framing; Government surfaces "service delivery" framing)

---

### M6 — Evals + Alerts + Production cutover **partially shipped**

Production cutover landed via a different path: the pilot runs from a local laptop exposed via Cloudflare Tunnel at `ai.thisisgravitas.com` (rather than full Railway hosting). Email notifications for KB ingest landed in P1.8. The eval harness + Slack alerts + daily digest email are still in Backlog — they're the next chunk to take on if/when the live pilot uncovers a quality regression we'd want guard rails against.

**Deliverables**

- **Eval harness** at `tests/evals/`:
  - Golden conversations (input opener + optional URL, expected nodes fired, expected `UIAction` types emitted)
  - LLM-as-judge using Claude Sonnet as judge against the Gravitas voice rubric
  - Runs weekly via Railway Cron; fails the run if pass rate drops > 5% week-over-week
- **Reviewer queue** in admin: Gravitas team can sample sessions, flag bad outputs; flags feed the eval set
- **Alerts** — Slack webhook + email when:
  - `calls_blocked > 0` for the day
  - daily spend > 80% of cap
  - KB ingest fails (zero pages crawled OR > 10% error rate)
  - Eval pass rate drops > 5% week-over-week
- **Daily digest email** summarizing the previous day (sessions, spend, top topics, blocked calls, KB freshness)
- **Production cutover** from Path A (home Windows box via Cloudflare Tunnel) to Path C (Railway):
  - Four Railway services (next-app, crawl, chroma, cron) with private networking
  - ChromaDB persistent volume attached
  - Custom domain `ai.thisisgravitas.com` configured with Cloudflare DNS
  - Ollama remains on the home box via Cloudflare Tunnel — Railway services call it through the tunnel
  - `<script src="https://ai.thisisgravitas.com/widget.js" defer></script>` added to thisisgravitas.com by the marketing-site team (with their CSP updated for `script-src` and `frame-src`)
  - All env vars migrated to Railway environment variable groups
  - Eval suite passes on staging before the DNS cutover

**Demo-able state**

- A weekly eval run catches any regression > 5% on the golden set
- A test "spend > 80%" event triggers the Slack + email alert within 60s
- Production is live at `ai.thisisgravitas.com`, embedded on thisisgravitas.com, end-to-end working
- Daily digest email lands at the configured recipients at 09:00 UTC

---

## Post-M6 polish (P1.11+) — shipped

Discrete fix-and-iterate batches in response to live-pilot feedback. Each is a single commit; gates (`pnpm typecheck && pnpm lint && pnpm test`) green before push.

| Batch | Shipped | Headline |
|---|---|---|
| **P1.11** | embed UX + admin-tunable rate limits | Embed onboarding screen at `/copilot?embed=1`; in-iframe header with recent-chats dropdown; expanded panel on canvas open via postMessage; admin Settings page with rate limits + "Reset today's quota" demo helper. Migration 0005 adds `system_settings` + `quota_reset_today()` RPC. |
| **P1.12** | worker call observability + Flow view | Worker PSI + Playwright calls log into `model_calls` with provider tags (`google-psi`, `playwright`). New `/admin/sessions/[id]/flow` page groups events by agent phase. New `docs/SESSION_FLOW.md` doc. |
| **P1.13** | Playwright Chromium on /admin/health | Worker `/health` reports `playwrightChromium: { installed, path }`. New Health card with one-line install hint. |
| **P1.14** | interactive Mermaid diagram on Flow | `mermaid` v11 dep; client-rendered sequence diagram with live data substituted (every arrow is a real event from the session, blocked calls drawn with `-x`). |
| **P1.15** | admin observability bundle | Pagination on `/admin/queries`. Scannable timeline (chat-style bubbles for visitor/assistant; thin telemetry rows for model calls + UI actions). Migration 0006 adds `request_payload` + `response_payload` JSONB to `model_calls`. Capture wired in router + worker. Flow page's External-call rows expand on click to show request/response JSON. |
| **P1.16** | bespoke deployability | Generalised `src/server/settings.ts` to any JSON-serialisable value. New tabbed `/admin/settings` (Rate limits / Branding / Embed widget / Knowledge base / Agent prompts). `/embed.js` becomes a dynamic Next.js route reading admin-defined defaults. Worker reads KB sitemap + whitelist from settings. Agent nodes read prompts via `getAgentPrompts() + resolvePrompt()` with `{{brand_name}}` etc. placeholders. |
| **P1.16.1** | fix embed.js merge priority | Flip so admin defaults win over GTM page-level config. Was the silent failure mode where saving admin colour/text appeared to do nothing. |
| **P1.17** | ChromaDB → Supabase pgvector | Migration 0007 enables `pgvector` extension, creates `kb_chunks` table with `vector(768)` column + `kb_chunks_search` RPC. Agent + worker both write/read via Supabase. New `/admin/kb/chunks?url=…` viewer for inspecting individual chunk content + metadata. ChromaDB Docker dependency removed entirely; Health page check swapped. |

Other interim fixes worth knowing about (not labelled as P1.N):
- Embed widget: animated dot loader inside the Send button while assistant streams (replaces a static `…`).
- Embed widget: per-conversation roster (10 chats max in `localStorage`, 30-day TTL); landing-page "Recent chats" list; URL is source-of-truth for active session (`/copilot?session=<uuid>`).
- Discovery: URL detection accepts bare hostnames (`adcb.com` → `https://adcb.com`); Gravitas URLs and URLs in non-audit-intent messages don't auto-trigger the audit pipeline.
- KB ingest: whitelist replaced with deny-list-only by default (was missing `/firstmakers`, `/contact`, `/experience-design-strategy`, etc.); admins can re-add a whitelist from `/admin/settings`.
- Print-to-PDF download path from the canvas (`window.print()` with print stylesheet).
- Profanity 3-strike guardrail (`src/lib/guardrails/profanity.ts`).

## Backlog (post-Phase 1)

Not part of the shipped Phase 1 build. Captured here so we don't forget.

**Deferred from M-series — promote when prioritised:**
- **Curated Answers** (was M4): admin authors canonical Markdown answers, `/admin/answers` CRUD, hybrid `kb_search` blending auto-crawled and curated with per-row weight. Topic-cluster "Create curated answer for this topic" pre-fill from `/admin/queries`.
- **Server-generated PDF** (was M5): full Gravitas template with annotated screenshot, served with a signed URL. P1.10 shipped `window.print()` as the interim; the full PDF generator is a real piece of work.
- **Industry-specific modes** (was M5): Banking / Government / Retail / Healthcare each tuning Discovery + Solution Map. Auto-detect from the visitor's opener.
- **Eval harness + alerts + daily digest** (was M6): golden conversations, LLM-as-judge weekly run, Slack + email alerts on cost / KB / eval regressions.
- **Full Railway production cutover** (was M6 alternative): the laptop+Cloudflare-Tunnel pilot stays for now; Railway is the right answer once the audience exceeds ~50 concurrent visitors.

**General product backlog:**
- Multilingual (Arabic priority given Gravitas's Gulf client base)
- Voice input
- Embedded onto specific Gravitas service pages with pre-filled context
- A/B test of canvas-first vs. chat-first openings
- CRM integration (HubSpot / Salesforce)
- Authenticated dashboards for returning enterprise leads
- Proposal generation (gated by a human reviewer regardless)
- CMS webhook for real-time KB updates (replaces the daily cron)
- Light mode
- Real-time admin view of an active session (websocket)
- Per-tenant Supabase project (currently single-tenant) for true multi-client deployments

---

## Success metrics

Tracked from production traffic (M6 onwards). Surfaced on the `/admin/cost` page and in the daily digest.

| Metric | Target |
|---|---|
| Session reaches canvas | ≥ 40% |
| Audit flow completes | ≥ 15% |
| Lead form submitted | ≥ 5% |
| Median session length | ≥ 3 min |
| Time to first canvas render | < 8s |
| Strategist voice rating (sampled) | ≥ 4/5 |
| Eval pass rate (weekly) | ≥ 95% |

---

## How work is verified (current cadence)

Each `P1.N` polish batch is a single commit with all gates green (`pnpm typecheck && pnpm lint && pnpm test`) before push. UI-visible changes get smoke-tested via `pnpm dev` or `pnpm build && pnpm start`. Schema changes get a migration file in `supabase/migrations/` — the user runs each new migration in the Supabase SQL editor before the corresponding code path activates.

When Claude Code hits a blocker that genuinely requires a decision (a third-party service unavailable, an architectural ambiguity, a credential the user must provide), it stops and asks. Otherwise: ship the batch, verify, push, move on.
