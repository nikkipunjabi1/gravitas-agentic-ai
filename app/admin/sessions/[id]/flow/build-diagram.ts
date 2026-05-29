/**
 * Build a Mermaid sequenceDiagram source string from a real session's
 * events. Each model_call becomes a labelled arrow with latency; each
 * canvas UIAction becomes a self-arrow showing what was emitted; visitor
 * messages become inbound arrows.
 *
 * Why dynamic rather than static template: the user wants to see what
 * THIS session did. A turn with no audit is visually different from one
 * with a full audit + strategy + output pipeline; rendering the same
 * generic diagram for both buries the difference.
 *
 * Output is valid Mermaid `sequenceDiagram` syntax. The component in
 * mermaid-diagram.tsx feeds it directly into mermaid.render.
 */

export interface DiagramSessionEvent {
  kind: "message" | "model_call" | "ui_action";
  ts: string;
  node: string | null;
  // model_call
  provider?: string;
  purpose?: string;
  latencyMs?: number | null;
  wasBlocked?: boolean;
  // message
  role?: string;
  // ui_action
  actionType?: string;
}

export interface DiagramInput {
  sessionId: string;
  events: DiagramSessionEvent[];
}

// Canonical actor list. Each agent node + each external dependency the
// pipeline can touch. The set is fixed so the diagram lays out
// consistently regardless of which actors actually got messages.
const ACTORS: Array<{ key: string; label: string }> = [
  { key: "V", label: "Visitor" },
  { key: "DISC", label: "Discovery" },
  { key: "AUD", label: "Audit" },
  { key: "STR", label: "Strategy" },
  { key: "MAP", label: "Mapping" },
  { key: "OUT", label: "Output" },
  { key: "PSI", label: "Google PSI" },
  { key: "PW", label: "Playwright" },
  { key: "OL", label: "Ollama" },
  { key: "CL", label: "Claude" },
];

// Map model_calls.provider → diagram actor key. Anything we don't know
// about is bucketed under Claude (the historical default).
const PROVIDER_TO_ACTOR: Record<string, string> = {
  anthropic: "CL",
  ollama: "OL",
  "google-psi": "PSI",
  playwright: "PW",
};

const NODE_TO_ACTOR: Record<string, string> = {
  discovery: "DISC",
  audit: "AUD",
  strategy: "STR",
  "solution-mapping": "MAP",
  output: "OUT",
};

export function buildDiagram(input: DiagramInput): string {
  const lines: string[] = ["sequenceDiagram"];
  lines.push("    autonumber");

  // Always declare every actor — keeps layout stable across sessions that
  // skipped some nodes. Mermaid greys out actors that never receive a
  // message, but the layout still includes them; that's the trade we want.
  for (const a of ACTORS) {
    lines.push(`    participant ${a.key} as ${escape(a.label)}`);
  }

  // Sort events by timestamp. Each event becomes one arrow.
  const sorted = [...input.events].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );

  for (const ev of sorted) {
    const line = encodeEvent(ev);
    if (line) lines.push(`    ${line}`);
  }

  if (sorted.length === 0) {
    lines.push("    Note over V: No events recorded for this session");
  }

  return lines.join("\n");
}

function encodeEvent(ev: DiagramSessionEvent): string | null {
  if (ev.kind === "message") {
    // Visitor → router. Assistant messages aren't shown as arrows here
    // because they're the OUTPUT of a node — better represented as the
    // closing arrow back to the visitor on the relevant model_call.
    if (ev.role === "user") {
      return `V->>DISC: visitor message`;
    }
    return null;
  }

  if (ev.kind === "model_call") {
    const actor = PROVIDER_TO_ACTOR[ev.provider ?? ""] ?? "CL";
    const from = NODE_TO_ACTOR[ev.node ?? ""] ?? "DISC";
    const label = composeCallLabel(ev);
    const arrow = ev.wasBlocked ? "-x" : "->>";
    return `${from}${arrow}${actor}: ${escape(label)}`;
  }

  if (ev.kind === "ui_action") {
    const from = NODE_TO_ACTOR[ev.node ?? ""] ?? "AUD";
    return `${from}->>V: canvas card · ${escape(ev.actionType ?? "?")}`;
  }

  return null;
}

function composeCallLabel(ev: DiagramSessionEvent): string {
  const parts: string[] = [];
  if (ev.purpose) parts.push(ev.purpose);
  if (ev.latencyMs != null) parts.push(formatMs(ev.latencyMs));
  if (ev.wasBlocked) parts.push("blocked");
  return parts.join(" · ");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Mermaid escape rules: colons separate the arrow from the message text,
 * and newlines / special chars in messages can break the parser. We strip
 * the obvious offenders rather than trying to handle the full grammar.
 */
function escape(s: string): string {
  return s
    .replace(/[\r\n]/g, " ")
    .replace(/[:;,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
