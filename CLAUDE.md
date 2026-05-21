# Claude Code instructions — Gravitas Transformation Co-Pilot

This file is the project memory Claude Code loads on every session. Read it first; it overrides defaults.

---

## First session on a new machine

If this is the first Claude Code session on this machine (e.g. switching from Mac planning to Windows dev):

1. `git pull` to ensure you have the latest planning docs (don't trust local clones — pull first).
2. Read this file end-to-end, then the docs in the order `README.md` lists.
3. Check `docs/ROADMAP.md` for the phase marked **IN PROGRESS**. That is the work in scope. Do not start any later phase.
4. **On Windows:** skim `docs/SETUP_WINDOWS.md` and confirm WSL2 + Node 22 + Ollama + ChromaDB (Docker) + Playwright deps are installed. If not, walk the user through that setup before scaffolding.
5. Confirm with the user **which task within the active phase** to start with. Do not assume.
6. When `pnpm dev` first works end-to-end, stop and report. Don't blow past the Definition of Done.

The current active phase as of this commit is **Phase 0 — Foundation**. It begins with `pnpm create next-app .` per the conventions and folder layout below.

---

## Before you write a line of code

1. Read [README.md](README.md), [docs/VISION.md](docs/VISION.md), and [docs/ROADMAP.md](docs/ROADMAP.md). They are the source of truth for *what* to build.
2. Then read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENTS.md](docs/AGENTS.md), and [docs/UI_CONTRACT.md](docs/UI_CONTRACT.md). They are the source of truth for *how*.
3. Read [docs/BRANDING.md](docs/BRANDING.md) before generating any user-facing artifact — chat copy, canvas component, report.
4. Read [docs/ADMIN_PANEL.md](docs/ADMIN_PANEL.md) before touching `/admin/*` routes, the logging chokepoint in the model router, or the Supabase log tables.
5. If a doc disagrees with a user instruction, ask — don't silently pick.

## Phasing — hard rule

We ship in phases (see `docs/ROADMAP.md`). **Do not start Phase N+1 work while Phase N is unfinished**, even if "it's only a small addition." If you see a tempting Phase 2 idea while building Phase 1, write it down in `docs/ROADMAP.md` under "Backlog" and move on.

The current phase is the one marked **IN PROGRESS** in `docs/ROADMAP.md`.

## Conventions

- **Language:** TypeScript, `strict` on. No `any` without a `// reason: ...` comment.
- **Framework:** Next.js App Router only. No Pages router.
- **Styling:** Tailwind + shadcn/ui. No CSS-in-JS libraries. No ad-hoc design tokens — extend Tailwind theme.
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

## Do not (without asking)

- Add a new paid service. Production stack is: **Anthropic API + Railway (one project hosting Next.js, crawl worker, Chroma, cron) + Supabase free tier + Cloudflare free tier**. Dev runs entirely on the developer's Windows + WSL2 box at $0 (Path A). See `docs/ARCHITECTURE.md` → Deployment paths. Anything else needs approval.
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

To be filled in when the project is scaffolded. Expected:

```bash
pnpm dev          # Next.js dev server
pnpm dev:worker   # crawl worker
pnpm test         # unit + integration
pnpm e2e          # Playwright
pnpm lint         # eslint + prettier check
pnpm typecheck    # tsc --noEmit
```

Before declaring a task "done": `pnpm lint && pnpm typecheck && pnpm test` must all pass. UI changes require manual smoke through the dev server (see global rules in the harness about not claiming success without verification).

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
