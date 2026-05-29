# Claude Code instructions — Gravitas Transformation Co-Pilot

This file is the project memory Claude Code loads on every session. Read it first; it overrides defaults.

---

## First session on a new machine

If this is the first Claude Code session on this machine (e.g. switching from Mac planning to Windows dev):

1. `git pull` to ensure you have the latest code + docs (don't trust local clones — pull first).
2. Read this file end-to-end, then the docs in the order `README.md` lists.
3. Check `docs/ROADMAP.md` for what's shipped + what's pending. Read **`docs/SESSION_FLOW.md`** if you're going to touch the agent graph or model routing — it's the canonical reference for "what happens when a visitor sends a message".
4. **On Windows:** skim `docs/SETUP_WINDOWS.md` and confirm Node 22 + Ollama + Playwright Chromium + Supabase access are configured. **ChromaDB is no longer required** (P1.17 replaced it with Supabase pgvector).
5. Confirm with the user what they want to work on. Do not assume.
6. Before declaring any change "done": `pnpm lint && pnpm typecheck && pnpm test` must pass + UI changes smoke-tested via `pnpm dev` (or `pnpm build && pnpm start` for production-mode behaviour).

**Current state of the project (P1.17 shipped):** Phase 1 milestones M1–M6 + post-milestone polish (P1.11–P1.17) are all landed in `origin/main`. The pilot runs from a local laptop (or `pnpm dev`/`pnpm start`) exposed via a Cloudflare Tunnel as `ai.thisisgravitas.com`. The product is configurable for bespoke client deployments from `/admin/settings` — see "Bespoke configuration" below.

---

## Before you write a line of code

1. Read [README.md](README.md), [docs/VISION.md](docs/VISION.md), and [docs/ROADMAP.md](docs/ROADMAP.md). They are the source of truth for *what* to build.
2. Then read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENTS.md](docs/AGENTS.md), and [docs/UI_CONTRACT.md](docs/UI_CONTRACT.md). They are the source of truth for *how*.
3. Read [docs/BRANDING.md](docs/BRANDING.md) before generating any user-facing artifact — chat copy, canvas component, report.
4. Read [docs/ADMIN_PANEL.md](docs/ADMIN_PANEL.md) before touching `/admin/*` routes, the logging chokepoint in the model router, or the Supabase log tables.
5. Read [docs/SESSION_FLOW.md](docs/SESSION_FLOW.md) before touching agent nodes — has the full Mermaid flow + per-node responsibilities + failure-path matrix.
6. Read [docs/PROMPTS.md](docs/PROMPTS.md) before changing any system prompt — every prompt is now also admin-tunable from `/admin/settings/prompts` (P1.16); the doc lists which key in `system_settings` overrides each hardcoded constant.
7. If a doc disagrees with a user instruction, ask — don't silently pick.

## Milestone discipline — hard rule (historical context)

Phase 1 milestones M1–M6 are **all shipped** as of P1.10. The discipline rule was: "don't start M_{N+1} while M_N is unfinished; each milestone must be demo-able end-to-end before the next begins." That guardrail did its job.

**Current work pattern (post-M6):** discrete `P1.N` polish batches that respond to live-pilot feedback. Each ships a focused change set (3–10 files), has its own commit, runs the gates, then pushes. The active list is in `docs/ROADMAP.md` under "Post-M6 polish (P1.11+)". Latest shipped: **P1.17** (ChromaDB → Supabase pgvector + chunks viewer).

## Conventions

- **Language:** TypeScript, `strict` on. No `any` without a `// reason: ...` comment.
- **Framework:** Next.js App Router only. No Pages router.
- **Styling:** Tailwind + shadcn/ui (skeleton). **Polish layer is required, not optional**: Framer Motion (component lifecycle), GSAP (scroll + time), Lenis (smooth scroll), Aceternity UI patterns (copied into `src/components/aceternity/`, not npm-installed), Vaul (drawers), Sonner (toasts), next-themes. No CSS-in-JS libraries. No ad-hoc design tokens — extend Tailwind theme. **Dark mode only** in Phase 1–3. Full visual direction in `docs/BRANDING.md` → Visual design language.
- **State:** Server Components by default. Client Components only where interactivity demands it.
- **Streaming:** Use the Vercel AI SDK Data Stream Protocol for agent responses. The canvas consumes structured `UIAction` events from the same stream — see `docs/UI_CONTRACT.md`.
- **Schemas:** Every external boundary (LLM tool args, API input, `UIAction` payloads) goes through a zod schema. No untyped JSON crossing a wire.
- **Secrets:** `.env.local` only. Never check in keys. Server-only modules import `process.env.*`; client modules never do.
- **Errors:** Fail loud in development, degrade gracefully in production. No silent `try { ... } catch {}`.

## Folder layout (target)

```
gravitas-agentic-ai/
├── app/                     ← Next.js App Router
│   ├── (site)/              ← public pages
│   ├── copilot/             ← the dual-pane experience
│   └── api/
│       ├── chat/            ← streaming agent endpoint
│       └── canvas/          ← UIAction validation, if needed
├── src/
│   ├── agents/              ← LangGraph nodes, state, tools
│   ├── canvas/              ← UIAction schema + component registry
│   ├── components/          ← shared UI (shadcn-based)
│   ├── lib/
│   │   ├── models/          ← Ollama + Claude clients, router
│   │   ├── crawl/           ← Playwright/Cheerio helpers (worker-side)
│   │   └── kb/              ← Gravitas knowledge base, embeddings, retrieval
│   └── server/              ← server-only utilities
├── worker/                  ← separate Node service for Playwright crawls
├── docs/
└── tests/
```

When in doubt, follow the file that already exists; don't invent a parallel structure.

## Model routing

| Use | Model |
|---|---|
| Internal reasoning, planning, intent detection | Ollama / DeepSeek-R1 (local) |
| User-facing copy, strategic recommendations, executive output | `claude-sonnet-4-6` via Anthropic API |
| Embeddings | Ollama / `nomic-embed-text` |
| Fast small tasks (classification, routing) | Ollama / Qwen3 or Phi-4 |

The router lives in `src/lib/models/`. **Do not call providers directly from agent nodes** — go through the router so we can swap models without surgery.

## Bespoke configuration — read this before changing visitor-facing surfaces

P1.16 + P1.18 + P1.19 made the entire visitor surface admin-tunable from `/admin/settings` (six tabs):

- **Rate limits** tab: IP daily turn + audit caps + "Reset today's quota" demo helper.
- **Branding** tab: brand name, named contact (name/role/email/phone) — substituted into prompts via `{{brand_name}}`, `{{contact_name}}`, etc. — AND the **AI-content disclaimer text** (P1.19) shown below the chat composer.
- **Embed widget** tab: launcher text, primary colour, text colour, position, dimensions. Drives the floating launcher on the parent site via `/embed.js` (P1.16: now a dynamic route, was a static file).
- **Knowledge base** tab: sitemap URL + optional whitelist of path prefixes.
- **Agent prompts** tab: every Discovery / Audit / Strategy / Output system prompt. Empty value = code default; saved = override with `{{var}}` substitution.
- **Features** tab (P1.18): three boolean flags — `feature_audit_enabled` (master switch — off = chatbot-only deployment, no audit/strategy/mapping/output canvas), `feature_audit_use_psi`, `feature_audit_use_playwright` (sub-switches for the worker's audit engines).

How it works under the hood:
- `src/server/settings.ts` — generalised key/value reader, 60s cache.
- `src/server/runtime-config.ts` — typed accessors per section.
- `app/embed.js/route.ts` — dynamic embed.js, admin defaults injected via IIFE (admin wins over GTM page-level config).
- Agent nodes (`src/agents/nodes/*.ts`) read prompts via `getAgentPrompts() + resolvePrompt()` with hardcoded fallbacks.
- Worker (`worker/src/kb-ingest.ts`) reads sitemap URL + whitelist via `worker/src/settings.ts`.

When adding new admin-tunable surfaces: add the key to `SETTING_KEYS`, write a typed accessor in `runtime-config.ts` with the hardcoded fallback, expose a card in `app/admin/settings/settings-tabs.tsx`, validate the input in `app/api/admin/settings/route.ts`. The pattern is repeated; follow what's there.

## Do not (without asking)

- Add a new paid service. Production stack is: **Anthropic API + Railway (one project hosting Next.js, crawl worker, cron) + Supabase free tier (with `pgvector` for the KB — replaces ChromaDB as of P1.17) + Cloudflare free tier**. Dev runs entirely on the developer's Windows box at $0 + a Cloudflare Tunnel for the public domain. See `docs/ARCHITECTURE.md` → Deployment paths. Anything else needs approval.
- Add a new agent or canvas component type beyond what's in `docs/AGENTS.md` and `docs/UI_CONTRACT.md`.
- **Bypass the daily cost cap.** Every call to Anthropic goes through `src/lib/models/router.ts`. The router checks the `cost_ledger` (Supabase) before every Claude call. `voice-heavy` calls refuse (throw `DailyCapExceeded`); `voice-light` calls silently swap to Ollama (lite mode). No raw `anthropic.messages.create` calls anywhere else in the code. See `docs/ARCHITECTURE.md` → Cost cap.
- **Mis-tier a purpose.** Every `router.complete()` call MUST tag `purpose` as `voice-light` (cheap, 2-4 sentence user-facing) or `voice-heavy` (audit narration, strategy synthesis, executive brief). Don't sneak heavy work through as light to avoid the cap — the per-call max-tokens cap is enforced separately. See `docs/AGENTS.md` → Model routing rules.
- **Skip the per-IP rate limit.** Every `/api/chat` request consumes one turn from `ip_quota`. Every Audit node invocation consumes one audit. Both checks live in `src/lib/quota/ip-quota.ts` and run BEFORE the agent graph. See `docs/ARCHITECTURE.md` → Rate limiting.
- **Bypass the logging chokepoint.** Every model call must be logged into `model_calls` by the same router. Every `UIAction` emitted must be logged into `ui_actions_emitted` by `src/lib/stream/ui-action.ts`. If a provider or emission path exists outside these, it's a bug. See `docs/ADMIN_PANEL.md`.
- **Expose any `/admin/*` route without auth middleware.** Every admin route is gated by Supabase session + `@thisisgravitas.com` email-domain allowlist.
- **Trust an unverified `postMessage` event.** The widget ↔ iframe bridge uses typed, zod-validated, origin-verified messages only. Allowed parent origins are `https://thisisgravitas.com` and `https://www.thisisgravitas.com`; allowed frame origin is `https://ai.thisisgravitas.com`. Any message that fails origin or schema validation is dropped and logged. Protocol definition: `src/widget/protocol.ts`. See `docs/ARCHITECTURE.md` → Embedding on thisisgravitas.com.
- **Add dependencies to `public/widget.js`.** The launcher script is vanilla TypeScript compiled to a single IIFE, < 5KB gzipped, no React, no bundler runtime. If a feature seems to require a library, redesign the feature.
- **Reference the Gravitas logo by URL at runtime.** Always import `GRAVITAS_LOGO_DATA_URI` from `@/lib/branding/logo`. See `docs/BRANDING.md`.
- **Use Claude for batch / post-hoc analytics.** Nightly jobs (topic clustering, intent extraction, weekly summaries) run on Ollama only. Anything you'd be tempted to throw Sonnet at "just for offline analysis" — use Ollama instead. The $50 cap is for live visitor sessions.
- Introduce a new state management library (no Redux, MobX, Jotai, Zustand without justification). Server Components + URL state + React state cover us.
- Ship without Playwright tests for any user-facing flow we claim is "done."
- Refactor or rename across more than three files in a single PR-equivalent change.
- Touch the existing `.git` history.

## Commands

```bash
# Install once
pnpm install                  # installs root + worker workspaces

# Dev loops (use these while iterating on features)
pnpm dev                      # Next.js dev server on :3001 (P1.12: was :3000)
pnpm dev:worker               # crawl worker (Fastify) on :8787

# Production-mode loops (use these for the pilot served via Cloudflare Tunnel)
pnpm build                    # one-time per code change
pnpm start                    # serves the built bundle on :3001

# Quality gates — must all pass before declaring "done"
pnpm lint                     # eslint (next/core-web-vitals + next/typescript)
pnpm typecheck                # tsc --noEmit at root + worker
pnpm test                     # vitest run (unit + integration)
pnpm e2e                      # Playwright smoke (boots dev server)

# One-off
pnpm branding:fetch           # downloads Gravitas logo SVG → src/lib/branding/logo.ts
pnpm kb:reseed                # full re-crawl of the sitemap (writes to Supabase pgvector)
```

`pnpm start` serves the **previous** `pnpm build` — code changes don't hot-reload. After any edit while running production-mode, you must `Ctrl-C → pnpm build → pnpm start`. Dev mode (`pnpm dev`) auto-recompiles; the dev-mode "N" badge is hidden via `devIndicators: false` in `next.config.ts`.

Before declaring a task "done": `pnpm lint && pnpm typecheck && pnpm test` must all pass, and any UI change must be smoke-tested manually through `pnpm dev` (see global rules in the harness about not claiming success without verification).

## Migrations to apply when bringing up a fresh Supabase project

Run each in order in the Supabase SQL editor (or via `supabase db push` if using the CLI). Without these, large pieces of the app silently fall back to defaults:

| File | What it adds | What breaks if you skip it |
|---|---|---|
| `0001_phase1_core.sql` | sessions, messages, model_calls, ui_actions_emitted, cost_ledger, ip_quota | Everything — no persistence |
| `0002_admin_email_guard.sql` | Trigger restricting admin sign-ups to `@thisisgravitas.com` | Anyone can sign in to `/admin/*` |
| `0003_kb_ingest_runs.sql` | KB ingest run history table | `/admin/kb` can't show recent runs |
| `0004_kb_notifications.sql` | KB ingest email-notification settings | KB cron can't send notifications |
| `0005_system_settings.sql` | `system_settings` table + `quota_reset_today()` RPC (P1.11) | `/admin/settings` falls back to defaults; no admin-tunable rate limits |
| `0006_model_call_payloads.sql` | request_payload + response_payload columns on model_calls (P1.15) | Flow page can't show request/response details |
| `0007_pgvector_kb.sql` | `pgvector` extension + `kb_chunks` table + `kb_chunks_search` RPC (P1.17) | KB queries return empty; agent never grounds in case studies |

## Voice (when generating user-facing copy)

Mirror Gravitas, don't invent a new brand. The four pillars guide tone:

- **Clarity** — turn confusion into clarity
- **Purpose** — design experiences anchored to clear intent
- **Simplicity** — tame complexity
- **Progress** — ship things that work *beautifully*

Avoid generic agency-speak ("we leverage cutting-edge solutions"). Prefer concrete, confident, declarative. The Co-Pilot should sound like the senior consultant in the room, not a brochure.

## When you finish a task

1. State what changed in one or two sentences.
2. List the files touched.
3. Note anything you punted to `ROADMAP.md` backlog and why.
4. Stop. Don't start the next thing without the user.
