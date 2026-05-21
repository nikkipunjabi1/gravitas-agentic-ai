# Agents

The reasoning core of the Co-Pilot. Read `VISION.md` and `ARCHITECTURE.md` first.

---

## Mental model

This is not a single LLM with a long prompt. It's a **LangGraph state machine** with named nodes, each with a tightly scoped responsibility, a typed input/output, and a chosen model. The graph is the agent. The nodes are not "agents that talk to each other" — they are stations on a deterministic workflow with the LLM doing the reasoning at each stop.

Why a graph instead of an autonomous loop:

- Predictable cost and latency
- Debuggable (you can see which node a session is stuck on)
- Easy to add a new station without re-prompting the whole thing
- We can swap a station's model without touching the others

Phase 3 may introduce a planning loop *within* one node. The top-level graph stays a graph.

---

## State

A single zod-validated object flows through the graph.

```ts
const SessionState = z.object({
  sessionId: z.string().uuid(),
  visitor: z.object({
    industry: z.string().nullable(),
    role: z.string().nullable(),
    namedProblem: z.string().nullable(),
    submittedUrl: z.string().url().nullable(),
  }),
  messages: z.array(ChatMessage),
  audit: AuditResult.nullable(),         // populated by Audit node
  strategy: StrategyResult.nullable(),   // populated by Strategy node
  solutionMap: SolutionMap.nullable(),   // populated by Mapping node
  uiActionsEmitted: z.array(z.string()), // ids of UIActions already sent
  phase: z.enum(["discovery","audit","strategy","mapping","output","done"]),
});
```

State is checkpointed to Supabase between node executions so a refresh resumes cleanly.

---

## Nodes

### 1. Discovery

**Purpose:** Capture the minimum context needed for the rest of the graph — industry, role, the named problem, and (optionally) a URL. **Also** handles visitors who arrive with informational questions about Gravitas rather than a stated problem — answers from the KB, then offers to go deeper.

**Inputs:** Latest user message, current `SessionState.visitor`.

**Outputs:** Updates `visitor`. May emit a `UIAction` of type `LeadGenFormLite` if the visitor offers contact info unprompted.

**Model:** Ollama / Qwen3 (fast classification + extraction + intent routing). Falls back to Claude Haiku if Ollama is unavailable. Claude Sonnet is used only when Discovery is composing a user-facing answer from KB material (the voice moment).

**Intent classification.** Every incoming visitor message is first classified into one of:

| Intent | What it means | What Discovery does |
|---|---|---|
| `problem-statement` | Visitor is naming a friction, goal, or situation | Continue the standard Discovery flow: extract industry/role/problem, ask the next gap-filling question |
| `gravitas-question` | Visitor is asking about Gravitas itself — services, work, philosophy, capability | Retrieve top-k chunks from the Gravitas KB via `kb_search`, answer in 2–4 sentences in Gravitas voice with an inline citation, then offer to go deeper into their situation |
| `meta-question` | Visitor is asking about the Co-Pilot itself ("are you AI?", "how does this work?") | Answer briefly and honestly, then redirect |
| `off-topic` | Unrelated to Gravitas or transformation | Acknowledge briefly, redirect once; if it persists, end the session gracefully |

The classifier prompt and the four response templates live in `src/agents/nodes/discovery.ts`. Keep them short and code-reviewed.

**KB-grounded answers:** when intent is `gravitas-question`, Discovery calls `kb_search({ query, k: 4 })`, composes a 2–4 sentence answer that quotes or paraphrases the retrieved material, and includes an inline link to the canonical Gravitas URL the chunk came from. **It never invents a case study, a service name, or a metric** — if the KB returns nothing relevant, Discovery says so and pivots to a question.

**Behavior:**
- One question at a time, never two
- Skips a question if the answer is already in state
- After ≤ 3 turns OR a URL is submitted, transitions to Audit (or Strategy if no URL)
- A `gravitas-question` turn does NOT count toward the 3-turn cap — informational engagement is welcome
- Voice: warm but not chatty. "Tell me one thing — what's the friction you're feeling today?"

### 2. Audit

**Purpose:** If a URL is present, produce a structured audit. If no URL, infer audit-equivalent context from Discovery answers.

**Inputs:** `visitor.submittedUrl`, `visitor.namedProblem`.

**Outputs:** `audit: AuditResult` and a `UIAction` of type `AuditFindings` rendered to the canvas as findings stream in.

**Model:** None for the crawl itself. DeepSeek-R1 (Ollama) reasons over the raw Playwright/Lighthouse JSON to produce findings. Claude Sonnet writes the user-facing narration that streams into the chat pane in parallel.

**Tools:**
- `crawl_url({ url })` → POSTs to the crawl worker, returns `{ performance, accessibility, semantic, designSignals, aiReadiness, contentArchitecture }`
- `render_ui({ action })` → emits a validated `UIAction` over the stream

**The Shadow Audit pattern:** the moment a URL is detected (even mid-Discovery), Audit kicks off in the background. By the time Discovery completes, the audit JSON is already in state, and the agent can drop a "I noticed your mobile checkout has a 3-second LCP — let's factor that in" into the conversation. This is the moment that creates *Instant Authority*. Implement as a parallel branch in the graph, not a separate process.

**One URL, one audit — no link following.** The Audit node analyses **exactly** the URL the visitor submitted. The crawl worker does NOT follow links, walk the sitemap, or open sibling pages. Per-IP `IP_DAILY_AUDIT_LIMIT=1` caps audits at one per day per visitor. If the visitor wants a different page audited, they wait for the daily reset. This scope discipline:

- Keeps audit cost predictable (one Playwright run, one Lighthouse pass, one Sonnet narration)
- Respects the cost cap
- Makes the auto-audit honestly distinct from a full Gravitas engagement (which audits 30+ pages)

The audit report explicitly says this — see `docs/BRANDING.md` → "About this audit" footer.

**Four-Lens scoring.** Audit findings are tagged with the lens they belong to (`usability` / `user-needs` / `conversion` / `design-execution`). Strategy combines findings into the `MaturityChart` (4-axis radar) and `RoadmapWidget` (Must / Should / Could). See `docs/BRANDING.md` for the methodology and `docs/UI_CONTRACT.md` for the schema.

### 3. Strategy

**Purpose:** Synthesize Discovery + Audit into a roadmap and maturity assessment.

**Inputs:** Full `SessionState`.

**Outputs:** `strategy: StrategyResult` containing `roadmap`, `maturityScores`, `quickWins`, `risks`. Emits two `UIAction`s: `MaturityChart` and `RoadmapWidget`.

**Model:** Claude Sonnet 4.6. This is the highest-stakes voice moment in the session — it must read like a Gravitas strategist.

**Grounding:** Retrieves the top-k Gravitas KB chunks (case studies, service pages, POV articles) from ChromaDB before composing. Cites at least one when relevant. Never fabricates a case study.

### 4. Solution Mapping

**Purpose:** Make the mapping from visitor problems to Gravitas services explicit and visible.

**Inputs:** `audit.findings`, `strategy.roadmap`, `visitor.namedProblem`.

**Outputs:** `solutionMap: SolutionMap` and a `UIAction` of type `SolutionMap`.

**Model:** Ollama / DeepSeek-R1 (classification-heavy, low creativity needed).

**Mapping table** (hard-coded in code, not in the prompt — the LLM tags findings with these labels):

| Finding category | Gravitas service |
|---|---|
| UX friction, conversion drop-off, journey complexity | Experience Strategy & Design |
| Performance, code debt, CMS limits, platform migration | Product Design & Engineering |
| Process fragmentation, team handoffs, operating model | Service Design & Operations |
| AI opportunity, RAG, automation, data plumbing | AI, Data & Automation |
| Skills gaps, training, design ops, dev ops | Capability & Enablement |

### 5. Output

**Purpose:** Close the session. Offer a downloadable artifact, a lead form, or a follow-up.

**Inputs:** Full `SessionState`.

**Outputs:** A closing message in chat. A `UIAction` of type `LeadGenForm` (Phase 2) or `ExecutiveBriefDownload` (Phase 3).

**Model:** Claude Sonnet 4.6.

---

## Edges

```
                   ┌─────────────┐
   start ─────────►│  Discovery  │──┐
                   └──────┬──────┘  │
                          │         │
                  visitor.submittedUrl?
                  ┌───────┴───────┐ │
                yes              no │
                  │               │ │
                  ▼               │ │
           ┌─────────────┐        │ │
           │   Audit     │────────┼─┤
           └──────┬──────┘        │ │
                  │               │ │
                  └──────┬────────┘ │
                         ▼          │
                  ┌─────────────┐   │
                  │  Strategy   │───┤
                  └──────┬──────┘   │
                         ▼          │
                  ┌──────────────────┐
                  │ Solution Mapping │──┤
                  └──────┬───────────┘  │
                         ▼              │
                  ┌─────────────┐       │
                  │   Output    │───────┤
                  └──────┬──────┘       │
                         ▼              │
                       end              │
                                        │
        DailyCapExceeded from any node  │
                                        ▼
                                 ┌─────────────┐
                                 │ CapReached  │ ──► end
                                 └─────────────┘
```

Discovery can loop on itself (more questions) until the gate condition is met. Every other node is single-pass in Phase 2. Phase 3 may allow Strategy ↔ Solution Mapping iteration.

**Cap-reached terminal node.** Any node calling `purpose: "voice"` (Discovery in gravitas-question mode, Audit narration, Strategy, Output) can throw `DailyCapExceeded` if the router refuses the call. A single global fallback edge routes any node's `DailyCapExceeded` to the `CapReached` node. `CapReached` does NOT call any LLM — it composes a static Gravitas-voiced message and emits a `DailyCapReached` UIAction that captures the visitor's email. See `ARCHITECTURE.md` → Cost cap, and `UI_CONTRACT.md` → `DailyCapReached`.

The Audit node is the most likely cap-tripping node because the audit JSON it narrates over is the largest single payload that hits Claude. Audit specifically estimates worst-case before invoking Claude and short-circuits early if the projection alone would exceed the cap — better to fail fast than to spend $49 of $50 on input tokens and then crash.

---

## Model routing rules

The router lives at `src/lib/models/router.ts`. Nodes call `router.complete({ purpose, messages, schema })` and never import a provider directly.

| `purpose` | Tier | Provider (normal) | Provider (lite mode — cap hit) | Model |
|---|---|---|---|---|
| `"intent"` | (Ollama) | Ollama | — | `qwen3` |
| `"reasoning"` | (Ollama) | Ollama | — | `deepseek-r1` |
| `"voice-light"` | light | Anthropic | **Ollama (Qwen3)** | `claude-sonnet-4-6` → `qwen3` |
| `"voice-heavy"` | heavy | Anthropic | **blocked → DailyCapReached** | `claude-sonnet-4-6` |
| `"classify"` | (Ollama) | Ollama | — | `qwen3` |
| `"embed"` | (Ollama) | Ollama | — | `nomic-embed-text` |

**Light vs heavy:**

- `voice-light` — Discovery answering a `gravitas-question` from KB; Output closing message; any 2–4 sentence user-facing turn. Typical cost: <$0.005.
- `voice-heavy` — Audit narration, Strategy synthesis, Executive Brief composition. Typical cost: $0.10–$1.00.

**Lite-mode swap** (when daily cost cap is hit): `voice-light` calls silently swap to Qwen3 via Ollama. The agent node doesn't know — the router returns a string either way. Voice quality drops modestly; informational accuracy is preserved (the KB chunks are the same).

**Hard block** (when daily cost cap is hit): `voice-heavy` calls throw `DailyCapExceeded`. Agent routes to `CapReached` terminal node.

Fallback chain for Ollama unavailability (CI, no GPU): all Ollama purposes degrade to `claude-haiku-4-5-20251001`. Never to Sonnet — that protects the cost ceiling. If both Ollama and the cap are unavailable for a `voice-light` call, the router returns a static template ("I can share what we found on the Gravitas site about this — [chunk]. We're at capacity for deeper conversations today; come back tomorrow.") rather than failing.

---

## Tool inventory

| Tool | Purpose | Where defined |
|---|---|---|
| `crawl_url` | POST to crawl worker, return audit JSON | `src/agents/tools/crawl-url.ts` |
| `kb_search` | Top-k chunks from Gravitas KB — **queries both `gravitas-kb` (auto-crawled) and `gravitas-curated` (admin-authored, Phase 2)**, merges results, applies the per-row `weight` boost | `src/agents/tools/kb-search.ts` |
| `render_ui` | Emit a validated `UIAction` to the stream | `src/agents/tools/render-ui.ts` |
| `generate_brief_pdf` | (Phase 3) build PDF, return signed URL | `src/agents/tools/brief-pdf.ts` |

**Hybrid retrieval — auto-crawled + admin-curated:**

- Phase 1: `kb_search` queries only `gravitas-kb` (auto-crawled from sitemap)
- Phase 2: `kb_search` becomes hybrid — also queries `gravitas-curated` (admin-authored via `/admin/answers`), merges results, applies each curated answer's `weight` multiplier (default 1.5×). When relevance is comparable, curated answers win.
- Trigger-phrase override: if a visitor's message contains any of a curated answer's `trigger_phrases` (exact match, case-insensitive), that answer surfaces regardless of embedding score. Use sparingly — embeddings are usually the right tool.

This is the high-value loop: admin observes a trending topic in `/admin/queries` → writes a canonical Gravitas answer in `/admin/answers` → the next visitor asking semantically close questions gets the curated answer, not a paraphrase of marketing copy. See `ADMIN_PANEL.md` → Curated Answers for the workflow.

Every tool:
- Declares a zod input schema and a zod output schema
- Returns `Result<T, E>` (no thrown errors crossing the agent boundary)
- Is unit-testable without the LLM in the loop

---

## Prompts

System prompts live in `src/agents/nodes/<node>.ts` next to the node code. **Do not put prompts in a separate `prompts/` folder** — they drift from the code that uses them. Each prompt:

- Opens with the node's purpose in one sentence
- States the voice (mirror Gravitas; see `VISION.md` voice section)
- Lists what to do AND what NOT to do
- Constrains output to the node's zod output schema
- Includes 1–2 calibrating examples, not 10

Prompt changes go through code review the same as any other change.

---

## Evals (Phase 3)

Golden conversations live in `tests/evals/`. Each golden has:

- Input: visitor opener + (optional) URL
- Expected: which nodes fired, which `UIAction`s emitted (by type), strategist-rating ≥ 4/5

The eval harness is LLM-as-judge with Claude Sonnet as the judge, against the Gravitas voice rubric. Run weekly; fail the run if pass rate drops > 5% week-over-week.

---

## What this design refuses

- **Autonomous multi-agent debate.** Two LLMs arguing produces fascinating logs and bad outcomes. The graph is the disagreement layer; nodes don't second-guess each other.
- **Long, monolithic prompts.** Each node prompt is ≤ 400 tokens of instructions. If a prompt grows beyond that, split the node.
- **Streaming JSON from the model.** The model returns text or structured (JSON schema) output. The agent code emits `UIAction`s explicitly — we never trust an LLM to format a `UIAction` correctly without a zod gate.
