# Gravitas Transformation Co-Pilot

A front-facing agentic AI layer for [thisisgravitas.com](https://thisisgravitas.com) that turns the website from a portfolio into a **consulting product**. Visitors describe a digital problem; the Co-Pilot reasons across UX, CX, technology, and AI dimensions and renders a tailored transformation roadmap — live, on a **Generative Canvas**.

> "We make Firsts. Not Followers." — Gravitas
>
> The website should behave the same way. This is the first front-end agent that *demonstrates* transformation thinking instead of describing it.

---

## What this is

A dual-pane experience hosted at **`https://ai.thisisgravitas.com`** and surfaced on the Gravitas marketing site via a floating launcher pill that opens it as a full-screen takeover.

- **Left pane — The Strategist.** Conversational agent that asks the right questions and reasons through the visitor's situation.
- **Right pane — The Canvas.** Dynamic surface where the agent *pulls in UI on demand* — roadmaps, maturity charts, audit findings, solution maps, lead forms — via typed tool calls.

The agent is grounded in real Gravitas services (Experience Strategy & Design, Product Design & Engineering, Service Design & Operations, AI/Data & Automation, Capability & Enablement) and mirrors the Gravitas voice (Clarity, Purpose, Simplicity, Progress).

## Read the docs in this order

1. **[VISION.md](docs/VISION.md)** — why this exists, who it's for, what "good" looks like
2. **[ROADMAP.md](docs/ROADMAP.md)** — what's shipped (M1–M6 + P1.11–P1.17) and what's still in the backlog
3. **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — stack, data flow, deployment topology
4. **[SESSION_FLOW.md](docs/SESSION_FLOW.md)** — what happens when a visitor sends a message: full sequence diagram + per-node breakdown + failure-path matrix
5. **[AGENTS.md](docs/AGENTS.md)** — multi-agent graph, model routing (Ollama + Claude), tools
6. **[PROMPTS.md](docs/PROMPTS.md)** — every system prompt in the codebase, with the admin-tunable key that overrides each
7. **[UI_CONTRACT.md](docs/UI_CONTRACT.md)** — the Generative Canvas: how the agent renders UI
8. **[BRANDING.md](docs/BRANDING.md)** — logo embedding, voice, audit report template
9. **[ADMIN_PANEL.md](docs/ADMIN_PANEL.md)** — internal dashboard: spend, sessions, transcripts, health, settings
10. **[SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md)** — Node + Ollama + Playwright first-run (ChromaDB no longer required as of P1.17)
11. **[CLAUDE.md](CLAUDE.md)** — instructions for Claude Code (conventions, guardrails, current state)

## Status

**Live pilot.** Phase 1 milestones M1–M6 shipped. Post-M6 polish batches P1.11–P1.17 also shipped: admin-tunable rate limits + branding + embed widget + agent prompts, request/response payload capture, Flow visualisation with Mermaid + payload expand-on-click, ChromaDB → Supabase pgvector migration with `/admin/kb/chunks` viewer. Running from a local laptop served at `ai.thisisgravitas.com` via Cloudflare Tunnel. See `docs/ROADMAP.md` for the running batch list.

## Stack at a glance

| Layer | Choice |
|---|---|
| Frontend — skeleton | Next.js (App Router) + Tailwind + shadcn/ui |
| Frontend — polish | Framer Motion + GSAP + Lenis + Aceternity UI patterns + Vaul + Sonner + next-themes. Dark-mode-only, matching thisisgravitas.com. Full direction in [BRANDING.md](docs/BRANDING.md). |
| Agent runtime | LangGraph (TypeScript) inside Next.js API routes |
| Crawl worker | Separate Node service running Playwright + Cheerio |
| Models — reasoning | Ollama / DeepSeek-R1 (local, free) |
| Models — user-facing copy & strategy | Claude Sonnet 4.6 via Anthropic API |
| Embeddings | Ollama / `nomic-embed-text` |
| Vector store | **Supabase `pgvector`** (as of P1.17 — replaces ChromaDB; no Docker dependency, browsable via Supabase Studio + `/admin/kb/chunks`) |
| Storage / auth | Supabase (free tier covers vectors + structured storage in one place) |
| Hosting (current pilot) | Self-hosted on Windows laptop, exposed via Cloudflare Tunnel (free) as `ai.thisisgravitas.com`. $0/mo. |
| Hosting (production path) | **Railway** — Next.js + crawl worker in one project (no separate Chroma service needed any more). ~$5–10/mo. See [ARCHITECTURE.md → Deployment paths](docs/ARCHITECTURE.md). |
| DNS / SSL / DDoS / Tunnel | Cloudflare free tier — sufficient, no upgrade needed. |

See `ARCHITECTURE.md` for the full picture.

## MVP scope (Phase 1)

- Dual-pane chat UI with streaming over the Vercel AI SDK Data Stream Protocol
- URL audit (one page, exactly): Playwright + Lighthouse + Cheerio against the visitor's submitted URL — no link-following
- **Five canvas components** mapped to the Four-Lens framework: `AuditFindings`, `MaturityChart` (4-axis), `RoadmapWidget` (Must / Should / Could), `KeepAndBuildOn`, `ThemesGrid`
- Hybrid model routing — Ollama (DeepSeek-R1 / Qwen3) for reasoning + free-tier voice fallback; Claude Sonnet 4.6 tagged `voice-light` or `voice-heavy`
- Daily $50 Anthropic cap with graceful Ollama lite-mode for light purposes when exceeded; `DailyCapReached` UIAction for heavy purposes
- Per-IP rate limits (20 chat turns + 1 audit / IP / day) with a visible counter when ≤ 5 turns remain
- Solution mapping to Gravitas's five services
- Gravitas KB seeded from thisisgravitas.com sitemap with scheduled daily incremental refresh
- Minimal admin panel at `/admin/*` for live cost + sessions + transcripts + health
- Marketing-site embedding: launcher pill on thisisgravitas.com opens the experience as a full-screen takeover iframe

Anything beyond that lives in `ROADMAP.md` and is **not built without approval**.
