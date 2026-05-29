# Prompts inventory — Gravitas Transformation Co-Pilot

> Every LLM-facing system prompt in the codebase is listed here. If you change a prompt, update this doc. If a model call exists without a corresponding entry, that's a bug.
>
> Generated for P1.10 review. Source of truth remains the files themselves — paths + line ranges are stated alongside each prompt so you can read the exact bytes.
>
> **P1.16 update — runtime overrides.** Every prompt below is also editable by admins via `/admin/settings/prompts`. The override key in the `system_settings` table is shown alongside each prompt as **Admin override key:**. When the override is empty/unset, the hardcoded constant in the file is used (current behaviour). When the override is set, the admin's value wins, with `{{brand_name}}`, `{{contact_name}}`, `{{contact_role}}`, `{{contact_email}}`, `{{contact_phone}}` placeholders substituted at runtime from the Branding tab.
>
> **Admin override keys (P1.16):**
> | Prompt section | `system_settings.key` |
> |---|---|
> | Discovery — VOICE_SYSTEM_BASE | `prompt_discovery_voice_base` |
> | Discovery — PROBLEM_SYSTEM | `prompt_discovery_problem` |
> | Discovery — KB_GROUNDED_SYSTEM | `prompt_discovery_kb_grounded` |
> | Discovery — KB_EMPTY_SYSTEM | `prompt_discovery_kb_empty` |
> | Discovery — META_SYSTEM | `prompt_discovery_meta` |
> | Discovery — OFFTOPIC_SYSTEM | `prompt_discovery_offtopic` |
> | Audit — inline narration | `prompt_audit_narration` |
> | Strategy — STRATEGY_SYSTEM | `prompt_strategy_json` |
> | Strategy — NARRATION_SYSTEM | `prompt_strategy_narration` |
> | Output — OUTPUT_SYSTEM | `prompt_output_close` |

---

## How to read this doc

Each section follows the same shape:

- **Where:** file path + symbol name + approximate line range.
- **Used by:** which node / pathway invokes it, and on which model purpose (`voice-light` / `voice-heavy` / `intent` / `embedding`).
- **Model that runs it:** which model the router resolves the purpose to (see "Model routing" below).
- **Purpose in plain English:** what we're asking the LLM to produce.
- **Full text:** the prompt verbatim.

---

## Model routing — which model runs which prompt

The router (`src/lib/models/router.ts`) maps `purpose` → model:

| Purpose | Model that runs | When it's used |
|---|---|---|
| `voice-light` | Claude Sonnet 4.6 (Anthropic API). If the daily cost cap is exhausted, silently swaps to Ollama DeepSeek-R1 (lite mode). | Cheap 2–4 sentence user-facing replies — Discovery responses, the closing Output turn. |
| `voice-heavy` | Claude Sonnet 4.6 (Anthropic API). Refuses with `DailyCapExceeded` if the cap is exhausted — does NOT silently downgrade. | Strategy JSON synthesis, Strategy narration, Audit narration. Anything where wrong voice would be visible. |
| `intent` | Ollama Qwen3 (local, free). | Discovery intent classification — currently bypassed by a heuristic for latency. Re-introduced in Phase 2 as ambiguity tiebreak. |
| `embedding` | Ollama `nomic-embed-text` (local, free). | KB embeddings during ingest + visitor-query encoding for retrieval. No prompt — input is raw text. |

The daily cap is configured in `.env.local` as `ANTHROPIC_DAILY_CAP_USD` (default $50). The ledger lives in Supabase (`cost_ledger` table) and is checked *before every Claude call*. See `docs/ARCHITECTURE.md` → Cost cap.

---

## 1. Discovery — `VOICE_SYSTEM_BASE`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 65–111).
- **Used by:** Every Discovery response. This is the base — five wrapper prompts below extend it.
- **Model that runs it:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** Establishes brand voice, hard topic guardrail, positive Gravitas stance, and push-to-contact rule for every user-facing reply.

The base prompt enforces:

1. **Identity** — Co-Pilot represents Gravitas; lists the five service areas exactly.
2. **HARD TOPIC GUARDRAIL** — only discusses (a) the visitor's digital/business problem, (b) Gravitas services + ownership, (c) URL audit, (d) how to reach Gravitas. Anything else → refuse + pivot in two sentences.
3. **POSITIVE GRAVITAS STANCE** — never undermine the brand; redirect competitor questions to what Gravitas does best.
4. **PUSH TO CONTACT** — every meaningful close invites reaching out (named contact via `BRANDING_CLOSING_CONTACT_*` env vars, falling back to `hello@thisisgravitas.com`).
5. **Voice rules** — Clarity / Purpose / Simplicity / Progress. 2–4 sentences. No agency-speak. No emoji. No vulgarity ever.
6. **Honesty** — never fabricate case studies, services, employee names, metrics.

---

## 2. Discovery — `PROBLEM_SYSTEM`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 113–119).
- **Used by:** When intent classifies as `problem-statement` (visitor names a friction or pastes a URL).
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** Acknowledge the friction, ask the next missing gap-filling question (in order: `namedProblem → industry → role → submittedUrl`), hand off implicitly once all four fields are filled.

Extends `VOICE_SYSTEM_BASE`. Hard cap: **one** question per reply.

---

## 3. Discovery — `KB_GROUNDED_SYSTEM`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 121–129).
- **Used by:** When intent classifies as `gravitas-question` AND KB retrieval returned chunks.
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** Answer questions about Gravitas using ONLY the top-k KB chunks. Paraphrase, cite at most one source inline as `([page-name](url))`. If the chunks don't actually answer the question, say so honestly and pivot.

Extends `VOICE_SYSTEM_BASE`. Critical rule: **never invent a case study, service name, or metric**.

---

## 4. Discovery — `KB_EMPTY_SYSTEM`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 131–133).
- **Used by:** When intent classifies as `gravitas-question` but the KB returned zero relevant chunks.
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** Two sentences — one honest "I don't have grounding on that yet", one pivot to the visitor's situation.

Extends `VOICE_SYSTEM_BASE`.

---

## 5. Discovery — `META_SYSTEM`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 135–140).
- **Used by:** When intent classifies as `meta-question` (visitor asked about the Co-Pilot itself).
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** Two sentences — one acknowledgement, one redirect to "what I'd like to do for you is…".

Extends `VOICE_SYSTEM_BASE`.

---

## 6. Discovery — `OFFTOPIC_SYSTEM`

- **Where:** `src/agents/nodes/discovery.ts` (≈ lines 142–148).
- **Used by:** When intent classifies as `off-topic`.
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** EXACTLY two sentences — sentence 1 politely declines without engaging the off-topic content (don't repeat or summarise it); sentence 2 pivots to a Gravitas-relevant prompt.

**Hard rule:** never answer the off-topic question, even partially. Refusal + pivot only.

---

## 7. Audit — inline narration system prompt

- **Where:** `src/agents/nodes/audit.ts`, inside `runAudit()` (≈ lines 160–170).
- **Used by:** Audit node, after KeepAndBuildOn + AuditFindings UIActions are emitted. Streams a 3-sentence narration back to chat.
- **Model:** Claude Sonnet 4.6 (`voice-heavy`).
- **Purpose:** Three sentences:
  1. URL audited + one calibrated overall observation.
  2. The single most impactful finding in plain language.
  3. Pivot to what the next response will cover (the Strategy synthesis).

Includes positive Gravitas stance and topic guardrail. Falls back to a deterministic narration (URL + top finding + "Pulling the synthesis together now.") if the router throws anything other than `DailyCapExceeded`.

---

## 8. Strategy — `STRATEGY_SYSTEM` (JSON synthesis)

- **Where:** `src/agents/nodes/strategy.ts` (≈ lines 242–298).
- **Used by:** Strategy node — composes the structured strategy report.
- **Model:** Claude Sonnet 4.6 (`voice-heavy`).
- **Purpose:** Output EXACTLY one JSON object matching the schema in `ClaudeStrategyJson`:
  - `maturity.axes` — four-axis scoring (Usability Standards/30, User Needs/20, Conversion/30, Design Execution/20) with rationale per axis.
  - `roadmap.must / should / could` — up to 6 items each, tagged to a `gravitasService` enum value.
  - `themes` — 4–6 cross-cutting themes.
  - `keepAndBuildOn` — 0–4 positive observations.

Includes the BRANDING scoring rubric calibration ("Most real pages score Developing — that is the calibrated norm"). Voice rules + positive Gravitas stance applied to every string. Single retry with a stricter wrapper if the first parse fails; if both fail, deterministic synthesis runs from audit data alone.

---

## 9. Strategy — `NARRATION_SYSTEM`

- **Where:** `src/agents/nodes/strategy.ts` (≈ lines 525–533).
- **Used by:** Strategy node — after the MaturityChart / ThemesGrid / RoadmapWidget UIActions are emitted, streams a 3-sentence narration to chat.
- **Model:** Claude Sonnet 4.6 (`voice-heavy`).
- **Purpose:** Three sentences narrating the strategy. Must reference the maturity total + the single highest-impact Must by name. The third sentence pushes to contact ("a conversation with the team").

Falls back to a deterministic stitch (`Maturity lands at X/100... The highest-impact Must is...`) if the router fails.

---

## 10. Output — `OUTPUT_SYSTEM`

- **Where:** `src/agents/nodes/output.ts` (≈ lines 40–52).
- **Used by:** Output node — the closing turn.
- **Model:** Claude Sonnet 4.6 (`voice-light`).
- **Purpose:** EXACTLY 4 sentences:
  1. Headline finding + maturity score summary.
  2. What a full Gravitas engagement would do that this 60-second pass cannot.
  3. PUSH TO CONTACT — warm handoff to the named contact (name/role/email/phone pulled from `BRANDING_CLOSING_CONTACT_*` env vars).
  4. Bilingual close: "Shukran! / شكراً" + a brief acknowledgement.

Positive Gravitas stance throughout. Deterministic fallback in `deterministicClose()` if the router fails.

---

## What is NOT a prompt (and why)

- **`src/agents/nodes/cap-reached.ts`** — emits a `CapReached` UIAction with hard-coded copy. No LLM call.
- **`src/agents/nodes/solution-mapping.ts`** — derives mappings from the strategy roadmap deterministically. No LLM call (Phase 2 may introduce one).
- **Intent classification in Discovery** — currently a heuristic in `heuristicIntent()` (regex on URLs, "gravitas", "what services", etc.). LLM-based classification existed in earlier passes but was removed for latency. Phase 2 may re-introduce as an ambiguity tiebreak.
- **Visitor-patch extraction in Discovery** — heuristic regex in `extractVisitorPatchHeuristic()`. URL via regex; namedProblem if the message contains a friction-shaped phrase. No LLM.
- **KB ingestion** — embeddings are computed on raw text with Ollama `nomic-embed-text`. No system prompt; the embedding model takes raw input.
- **Audit findings derivation** — `deriveFindings()` and `deriveStrengths()` in `src/agents/findings.ts` are pure heuristic rules. No LLM.

---

## Profanity guardrail (not a prompt, but related)

The user-message content guard is **not** an LLM prompt — it's a deterministic word-boundary regex with leet-substitution normalisation. Lives in `src/lib/guardrails/profanity.ts`.

- Three profane messages → session is suspended (in-memory, resets on restart; Phase 2 swaps for a Supabase column).
- Suspended sessions short-circuit at the top of `app/api/chat/route.ts` *before* the agent graph runs. The visitor receives a fixed refusal pointing at the Gravitas contact email — no LLM is invoked.
- Word list is intentionally narrow (abusive slurs + obscenities). Phase 2 swap target: a real content-moderation API.

See `src/lib/guardrails/profanity.ts` for the full rule set.

---

## Change-log convention

When you edit any prompt above:

1. Update the verbatim text in the file.
2. Update the "Purpose in plain English" entry here if behaviour shifts.
3. Bump the line-range numbers if they drifted significantly.
4. If the prompt newly enforces a brand or safety rule, add a one-line note under the prompt's section.

If you ADD a new system prompt anywhere in the codebase, add a section here. The rule is: **every LLM-facing system prompt is listed in this doc**.
