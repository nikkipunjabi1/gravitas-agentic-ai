# UI Contract — the Generative Canvas

How the agent "pulls in UI on demand." The contract between the agent runtime and the canvas pane.

Read `AGENTS.md` and `ARCHITECTURE.md` first. If you need a hands-on starter, jump to **"Adding a new canvas component"** at the bottom — it walks through the four-step recipe using the P1.18 `ContactCard` as the worked example.

---

## The model

The canvas is a **dispatched render surface**. It does not know what will be rendered next. When the agent runtime decides a piece of UI is useful, it emits a `UIAction` — a typed, validated, versioned payload — over the same stream the chat pane is consuming. The canvas frontend parses each action, looks up the component in a registry, and mounts it.

Three rules govern every `UIAction`:

1. **Typed.** Discriminated union, validated by zod. No untyped payload reaches a component.
2. **Self-sufficient.** The component renders from props alone. No fetching, no global state reads, no implicit context.
3. **Deterministic.** Same payload → same render. No randomness, no `new Date()` inside the component.

If those three hold, debugging is easy: you can replay a session by replaying its `UIAction` log.

---

## Schema

`src/canvas/schema.ts`:

```ts
import { z } from "zod";

export const UIAction = z.discriminatedUnion("type", [
  z.object({
    // AuditFindings carries a `lens` tag so the canvas can group by the Four-Lens framework
    // (see BRANDING.md). Findings follow the Gravitas convention: title = the issue, not the fix.
    type: z.literal("AuditFindings"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      findings: z.array(z.object({
        id: z.string(),
        lens: z.enum(["usability","user-needs","conversion","design-execution"]),
        category: z.enum(["ux","performance","accessibility","semantic","design-system","ai-readiness","content","mobile","i18n","trust"]),
        severity: z.enum(["low","medium","high","critical"]),
        title: z.string().max(80),       // ≤ 10 words, the issue not the fix
        detail: z.string().max(360),     // ≤ 60 words, why it matters
        gravitasService: z.enum([
          "experience-strategy-design",
          "product-design-engineering",
          "service-design-operations",
          "ai-data-automation",
          "capability-enablement",
        ]).nullable(),
      })),
    }),
  }),

  z.object({
    // Four-Lens Framework radar — matches the Gravitas audit methodology (see BRANDING.md)
    type: z.literal("MaturityChart"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      axes: z.array(z.object({
        label: z.enum([
          "Usability Standards",   // D1, raw out of 30
          "User Needs",            // D2, raw out of 20
          "Conversion",            // D3, raw out of 30
          "Design Execution",      // D4, raw out of 20
        ]),
        normalizedScore: z.number().min(0).max(10),  // for radar geometry (every axis on same scale)
        rawScore: z.number(),                         // actual lens score
        maxScore: z.union([z.literal(20), z.literal(30)]),
        rationale: z.string().max(200),
      })).length(4),
      totalScore: z.number().min(0).max(100),         // sum of rawScores
      targetScore: z.number().min(0).max(100).nullable(),  // optional post-engagement target, e.g. 75
    }),
  }),

  z.object({
    // RoadmapWidget supports two labelling modes:
    //  - mode "horizons": time-based — "Quick wins" / "Next 90 days" / "6–12 months"
    //  - mode "priority": Gravitas audit convention — "Must" / "Should" / "Could"
    // The agent picks one mode per emission; the canvas renders consistent labels.
    type: z.literal("RoadmapWidget"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      mode: z.enum(["horizons","priority"]),
      groups: z.array(z.object({
        label: z.enum([
          "Quick wins","Next 90 days","6–12 months",
          "Must","Should","Could",
        ]),
        items: z.array(z.object({
          title: z.string().max(80),
          why: z.string().max(240),
          gravitasService: z.enum([
            "experience-strategy-design",
            "product-design-engineering",
            "service-design-operations",
            "ai-data-automation",
            "capability-enablement",
          ]),
        })).max(6),
      })).length(3),
    }),
  }),

  z.object({
    type: z.literal("SolutionMap"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      mappings: z.array(z.object({
        visitorPhrase: z.string().max(160),  // exact phrasing the visitor used
        service: z.enum([
          "experience-strategy-design",
          "product-design-engineering",
          "service-design-operations",
          "ai-data-automation",
          "capability-enablement",
        ]),
        rationale: z.string().max(240),
        caseStudyRef: z.string().nullable(), // e.g. "adcb-ai-knowledge-base"
      })),
    }),
  }),

  z.object({
    type: z.literal("TechStackReco"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      currentSignals: z.array(z.string()).max(8),
      recommended: z.array(z.object({
        layer: z.string(),
        choice: z.string(),
        rationale: z.string().max(200),
      })),
    }),
  }),

  z.object({
    type: z.literal("LeadGenForm"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      headline: z.string().max(120),
      fields: z.array(z.enum(["name","email","company","role","phone"])).min(2),
      submitLabel: z.string().max(40),
    }),
  }),

  z.object({
    type: z.literal("ExecutiveBriefDownload"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      title: z.string().max(120),
      pageCount: z.number().int().positive(),
      downloadUrl: z.string().url(),
      expiresAt: z.string().datetime(),
    }),
  }),

  z.object({
    type: z.literal("DailyCapReached"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      headline: z.string().max(120),
      body: z.string().max(400),
      emailFieldLabel: z.string().max(60),
      submitLabel: z.string().max(40),
      sessionId: z.string().uuid(),         // posted back so the waitlist row links to the session
      intendedUrl: z.string().url().nullable(),  // URL the visitor was trying to audit, if any
    }),
  }),

  z.object({
    // Positive findings — "what this page does well today". Rendered before critique in audit reports.
    // Mirrors the Gravitas "Keep & Build On" section (see BRANDING.md).
    type: z.literal("KeepAndBuildOn"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      strengths: z.array(z.object({
        title: z.string().max(80),
        detail: z.string().max(240),
        lens: z.enum(["usability","user-needs","conversion","design-execution"]),
      })).min(2).max(4),
      alsoWorking: z.array(z.string().max(120)).max(5).default([]),  // shorter, bullet-list items
    }),
  }),

  z.object({
    // Cross-cutting themes — 4-6 patterns that span lenses. Drives the redesign narrative.
    type: z.literal("ThemesGrid"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      themes: z.array(z.object({
        title: z.string().max(80),
        body: z.string().max(280),
      })).min(4).max(6),
    }),
  }),

  z.object({
    // Visitor's per-IP daily quota exhausted (turns or audits). Different from DailyCapReached
    // (which is the global $50 cap). No email capture here — anti-abuse, not lead capture.
    type: z.literal("RateLimitReached"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.object({
      reason: z.enum(["turns","audits"]),
      headline: z.string().max(120),
      body: z.string().max(400),
      remainingResetIn: z.string().max(60),  // e.g. "in 6 hours" — human-readable
    }),
  }),

  z.object({
    type: z.literal("DebugAction"),
    id: z.string().uuid(),
    version: z.literal(1),
    data: z.unknown(),
  }),
]);

export type UIAction = z.infer<typeof UIAction>;
```

**Every action carries a `version` field.** When a payload changes shape, bump the version and keep the old branch in the union for one release. Components must check version before rendering.

---

## Registry

`src/canvas/registry.tsx`:

```ts
import type { UIAction } from "./schema";
import { AuditFindings } from "./components/audit-findings";
import { MaturityChart } from "./components/maturity-chart";
import { RoadmapWidget } from "./components/roadmap-widget";
// ...

export const registry: {
  [K in UIAction["type"]]: React.ComponentType<{
    action: Extract<UIAction, { type: K }>;
  }>;
} = {
  AuditFindings,
  MaturityChart,
  RoadmapWidget,
  SolutionMap,
  TechStackReco,
  LeadGenForm,
  ExecutiveBriefDownload,
  KeepAndBuildOn,
  ThemesGrid,
  DailyCapReached,
  RateLimitReached,
  DebugAction,
};
```

The TypeScript ensures every action type has a component. Adding a new action type that isn't in the registry is a compile error.

---

## Wire protocol

The agent runtime emits `UIAction`s as **data parts** on the Vercel AI SDK stream.

**Server side** (`src/lib/stream/ui-action.ts`):

```ts
export function emitUIAction(stream: DataStreamWriter, action: UIAction) {
  const parsed = UIAction.safeParse(action);
  if (!parsed.success) {
    console.error("invalid UIAction dropped", parsed.error);
    return;
  }
  stream.writeData({ type: "ui-action", action: parsed.data });
}
```

**Client side** (`/copilot/page.tsx`):

```ts
const { messages, data } = useChat({ api: "/api/chat" });

useEffect(() => {
  if (!data) return;
  const last = data[data.length - 1];
  if (typeof last === "object" && (last as any).type === "ui-action") {
    const parsed = UIAction.safeParse((last as any).action);
    if (parsed.success) canvasStore.push(parsed.data);
  }
}, [data]);
```

The canvas pane reads from `canvasStore` and renders the latest N actions. Older actions remain visible (scroll); they are not replaced unless the agent explicitly emits a successor with the same `id`.

---

## Replacing vs. appending

- **Append** (default): emit a new action with a new `id`. The canvas adds it to the stack.
- **Replace**: emit a new action with the same `id` as a previously-emitted one. The canvas swaps the component in place. Use this for the streaming Audit case: emit a partial `AuditFindings` early, then replace with the complete one when crawl finishes.

The replace contract requires the component to handle the partial → complete transition gracefully (skeleton state, no layout shift).

---

## Component rules

Every canvas component:

1. Is a Server Component or a Client Component — **never an isomorphic mystery**. Pick one and put `"use client"` at the top if it needs interactivity.
2. Accepts exactly one prop: `{ action: <its action type> }`. No optional props, no children.
3. Renders deterministically from `action.data`. No fetches, no `localStorage`, no `Date.now()`.
4. Uses only Tailwind classes from the theme — no inline styles, no one-off colors.
5. Animates on mount via Framer Motion with the shared `canvasEnter` variant. Consistency matters more than expressiveness here.
6. Has a Storybook (or equivalent) story with at least: minimal payload, full payload, edge-case payload (empty arrays, max-length strings).
7. Has a snapshot test pinned to a sample action.

If a component needs to *do something* on interaction (submit a lead form, trigger a download), it dispatches through a typed callback exposed from `src/canvas/actions.ts` — never directly calls fetch.

---

## Adding a new action type — checklist

1. Add the branch to the `UIAction` discriminated union in `src/canvas/schema.ts`, with a `version: z.literal(1)`.
2. Write the component in `src/canvas/components/<name>.tsx`.
3. Register it in `src/canvas/registry.tsx`. TypeScript will fail until this is done — that's the point.
4. Add a Storybook story.
5. Add a snapshot test.
6. Update the relevant agent node to know how to emit it (`render_ui` tool call).
7. Add a line to this doc's schema section.

If you skip step 1 and emit an unknown action, the validator drops it and logs. The agent will not retry. Treat that as a bug, not a feature.

---

## Anti-patterns

- **Treating the LLM as the source of truth for the payload shape.** The LLM produces *content*; the agent code wraps it in a `UIAction`. Never let the model emit raw JSON that you trust.
- **Two streams, one for chat and one for canvas.** They desync. Use one stream with typed data parts.
- **Components that fetch their own data.** That's a different architecture. Here, the agent prepares everything the component needs.
- **A "generic" component that handles many types via props.** Defeats the registry. Add a new branch instead.

---

## Adding a new canvas component — worked example (P1.18)

`ContactCard` (added in P1.18) is shipped as the canonical "copy this pattern" example. Walk through the four files it touches; mirror them for any new component you add.

### Step 1 — schema branch

`src/canvas/schema.ts`. Add a new `z.object` describing your component's payload, then include it in the `z.discriminatedUnion` AND in the `UI_ACTION_TYPES` const array.

```ts
const Foo = z.object({
  type: z.literal("Foo"),
  id: z.string().uuid(),
  version: z.literal(1),
  data: z.object({
    // your fields
    title: z.string().min(1).max(120),
    body: z.string().max(400).optional(),
  }),
});

export const UIAction = z.discriminatedUnion("type", [
  // …existing branches…
  Foo,
]);

export const UI_ACTION_TYPES: readonly UIActionType[] = [
  // …existing entries…
  "Foo",
] as const;
```

If you skip the `UI_ACTION_TYPES` entry the count test in `tests/canvas/schema.test.ts` will fail — that's the canary.

### Step 2 — component file

`src/canvas/components/foo.tsx`. Render from `action.data` alone. Use the shared `<CanvasCard>` shell for the chrome so your component matches the rest of the Phase-1 surfaces without copy-pasting border / radius / animation rules.

```tsx
"use client";

import { CanvasCard } from "./_shell";
import type { UIActionOf } from "@/canvas/schema";

export function Foo({ action }: { action: UIActionOf<"Foo"> }) {
  const { title, body } = action.data;
  return (
    <CanvasCard label="Foo" id={action.id} tone="default">
      <div className="space-y-2 px-4 py-3">
        <p className="text-sm font-medium text-ink">{title}</p>
        {body ? <p className="text-xs text-ink-soft">{body}</p> : null}
      </div>
    </CanvasCard>
  );
}
```

Three rules, repeated for emphasis:

1. **No fetching** — no `fetch()`, no `useEffect` that pulls data.
2. **No globals** — don't read `window.*`, `document.*`, or any context.
3. **Deterministic** — no `Date.now()`, no `Math.random()` inside the component. Animations may use `framer-motion` because it's tied to lifecycle, not wall-clock state.

### Step 3 — registry entry

`src/canvas/registry.tsx`. Import the component and add it to the `registry` map. TypeScript will reject the file until every union branch is mapped — exactly the compile-time guarantee that makes step 1 + step 3 stay in lockstep.

```tsx
import { Foo } from "@/canvas/components/foo";

export const registry: {
  [K in UIActionType]: React.ComponentType<{ action: Extract<UIAction, { type: K }> }>;
} = {
  // …existing entries…
  Foo,
};
```

### Step 4 — agent emit-site

Have whichever agent node should produce this card call `renderUI(writer, action, { sessionId, node })`. Example from `src/agents/nodes/output.ts`:

```tsx
import { renderUI } from "@/agents/tools/render-ui";

renderUI(
  ctx.writer,
  {
    type: "Foo",
    id: crypto.randomUUID(),
    version: 1,
    data: { title: "Hello", body: "World" },
  },
  { sessionId: ctx.sessionId, node: "output" },
);
```

`renderUI` validates the payload against the schema before sending it down the stream, logs it into `ui_actions_emitted` for the admin panel, and writes the data part the canvas client will consume.

That's the entire surface. Five files: schema, component, registry, agent node, optional doc entry above. The `ContactCard` PR (P1.18) touches exactly these five.
