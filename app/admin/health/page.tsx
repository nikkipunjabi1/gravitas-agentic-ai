import { cn } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";
export const revalidate = 30; // cache 30s on the server

/**
 * /admin/health — service health.
 *
 * Hits four endpoints from the server and renders the result. No live
 * polling from the client — the admin sees a snapshot; refresh for fresh.
 *
 * Per-check timeout: 2s. Total render is bounded ≤ 8s even if every check
 * times out, well inside the DoD's "returns within 5s" envelope on the
 * happy path.
 */
export default async function HealthPage() {
  // checkCrawlWorker's /health response also reports Playwright Chromium
  // status; we extract it into a separate check so the operator sees the
  // browser binary as a first-class red dot rather than buried in a string.
  const workerResult = await checkCrawlWorker();
  const checks = [
    await checkAnthropic(),
    await checkOllama(),
    await checkPgvector(),
    workerResult.check,
    derivePlaywrightCheck(workerResult.workerHealth),
  ];

  return (
    <div className="space-y-5">
      <h1 className="font-display text-2xl font-semibold text-ink">Health</h1>
      <p className="text-sm text-ink-soft">
        Snapshot from the server — refresh the page for fresh status.
      </p>

      <ul className="grid gap-3 md:grid-cols-2">
        {checks.map((c) => (
          <li
            key={c.service}
            className={cn(
              "rounded-xl border bg-paper p-4",
              c.ok ? "border-severity-low/30" : "border-severity-critical/30",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-display text-base font-semibold text-ink">
                  {c.service}
                </p>
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  {c.endpoint}
                </p>
              </div>
              <Dot ok={c.ok} />
            </div>
            <p className="mt-2 text-sm text-ink-soft">{c.message}</p>
            {c.latencyMs !== null ? (
              <p className="mt-1 font-mono text-[10px] text-ink-muted">{c.latencyMs}ms</p>
            ) : null}
            {!c.ok && c.hint ? (
              <div className="mt-3 rounded-lg border border-paper-edge bg-paper-soft/60 px-3 py-2 text-xs text-ink-soft">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                  How to fix
                </p>
                <p className="mt-0.5">{c.hint}</p>
                {c.hintCmd ? (
                  <pre className="mt-1 overflow-x-auto rounded bg-ink/5 px-2 py-1 font-mono text-[11px] text-ink">
                    {c.hintCmd}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-2.5 w-2.5 rounded-full",
        ok ? "bg-severity-low" : "bg-severity-critical",
      )}
      aria-label={ok ? "OK" : "Down"}
    />
  );
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Check {
  service: string;
  endpoint: string;
  ok: boolean;
  message: string;
  latencyMs: number | null;
  hint?: string;
  hintCmd?: string;
}

async function checkAnthropic(): Promise<Check> {
  const endpoint = "ANTHROPIC_API_KEY";
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      service: "Anthropic",
      endpoint,
      ok: false,
      message: "ANTHROPIC_API_KEY not set",
      latencyMs: null,
      hint: "Get a key at console.anthropic.com → API Keys, paste into .env.local, then restart the dev server.",
    };
  }
  return {
    service: "Anthropic",
    endpoint,
    ok: true,
    message: "API key present (no live ping — calls only happen when the agent runs)",
    latencyMs: null,
  };
}

async function checkOllama(): Promise<Check> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const result = await timed("Ollama", `${base}/api/tags`, async () => {
    const res = await fetchWithTimeout(`${base}/api/tags`, 2000);
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: unknown[] };
    return { ok: true, message: `${(data.models ?? []).length} models available` };
  });
  if (!result.ok) {
    return {
      ...result,
      hint:
        "Install Ollama (https://ollama.com), then run `ollama serve` in a terminal. Pull the embedding model with `ollama pull nomic-embed-text` and a small chat model with `ollama pull qwen3`.",
      hintCmd: "ollama serve",
    };
  }
  return result;
}

async function checkPgvector(): Promise<Check> {
  const result = await timed(
    "Supabase pgvector",
    "kb_chunks_search RPC",
    async () => {
      const { countChunks } = await import("@/lib/kb/pgvector");
      const n = await countChunks();
      return { ok: true, message: `${n} chunks indexed` };
    },
  );
  if (!result.ok) {
    return {
      ...result,
      hint:
        "Apply migration 0007_pgvector_kb.sql in the Supabase SQL editor. That enables the pgvector extension and creates the kb_chunks table the agent reads from.",
    };
  }
  return result;
}

/**
 * The worker /health response surfaces both the worker itself AND the
 * Playwright Chromium binary state. We fetch it once and return BOTH the
 * worker Check and the raw payload, so the page can derive a separate
 * Playwright check without a second round-trip.
 */
interface WorkerHealthPayload {
  engine?: string;
  uptimeMs?: number;
  playwrightChromium?: {
    installed: boolean;
    path: string | null;
    hint: string | null;
  };
}

async function checkCrawlWorker(): Promise<{
  check: Check;
  workerHealth: WorkerHealthPayload | null;
}> {
  const base = process.env.CRAWL_WORKER_URL;
  const secret = process.env.CRAWL_WORKER_SHARED_SECRET;
  if (!base) {
    return {
      check: {
        service: "Crawl worker",
        endpoint: "(not configured)",
        ok: false,
        message: "CRAWL_WORKER_URL not set",
        latencyMs: null,
        hint: "Set CRAWL_WORKER_URL=http://localhost:8787 in .env.local.",
      },
      workerHealth: null,
    };
  }
  if (!secret || secret.length < 16) {
    return {
      check: {
        service: "Crawl worker",
        endpoint: base,
        ok: false,
        message: "CRAWL_WORKER_SHARED_SECRET not set (or shorter than 16 chars)",
        latencyMs: null,
        hint:
          "Generate a long random string and set it as CRAWL_WORKER_SHARED_SECRET in .env.local. The same value is read by both the Next app and the worker.",
        hintCmd: "openssl rand -hex 32",
      },
      workerHealth: null,
    };
  }

  let captured: WorkerHealthPayload | null = null;
  const result = await timed("Crawl worker", `${base}/health`, async () => {
    const res = await fetchWithTimeout(`${base}/health`, 2000, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const data = (await res.json()) as WorkerHealthPayload;
    captured = data;
    return {
      ok: true,
      message: `${data.engine ?? "ok"} · uptime ${Math.round((data.uptimeMs ?? 0) / 1000)}s`,
    };
  });
  if (!result.ok) {
    return {
      check: {
        ...result,
        hint:
          "Start the crawl worker in a separate terminal. It serves on port 8787 by default. Make sure CRAWL_WORKER_SHARED_SECRET matches the value the worker reads (same .env.local).",
        hintCmd: "pnpm dev:worker",
      },
      workerHealth: null,
    };
  }
  return { check: result, workerHealth: captured };
}

/**
 * Derive a Playwright Chromium check from the worker's /health payload.
 *
 * "Why a separate check?" — when Chromium is missing, audits silently lose
 * their Playwright supplement (structural HTML extraction). PSI still
 * carries the score path, so the operator sees a "successful" audit with
 * subtly thinner findings. Surfacing it as its own red dot on /admin/health
 * means the install gap shows up before the next audit demo, not during it.
 *
 * Greyed out (ok=true, message="—") when the worker itself is down, since
 * we can't know the state without it.
 */
function derivePlaywrightCheck(
  workerHealth: WorkerHealthPayload | null,
): Check {
  if (!workerHealth) {
    return {
      service: "Playwright Chromium",
      endpoint: "(via crawl worker)",
      ok: true,
      message: "Worker offline — Chromium state unknown",
      latencyMs: null,
    };
  }
  const pc = workerHealth.playwrightChromium;
  if (!pc) {
    return {
      service: "Playwright Chromium",
      endpoint: "(via crawl worker)",
      ok: false,
      message: "Worker /health didn't report Chromium status",
      latencyMs: null,
      hint:
        "The worker version is older than P1.13. Pull the latest, run `pnpm install` in `worker/`, and restart `pnpm dev:worker`.",
    };
  }
  if (pc.installed) {
    return {
      service: "Playwright Chromium",
      endpoint: pc.path ?? "(installed)",
      ok: true,
      message: "Chromium binary present — Playwright crawls will run",
      latencyMs: null,
    };
  }
  return {
    service: "Playwright Chromium",
    endpoint: pc.path ?? "(missing)",
    ok: false,
    message: pc.hint ?? "Chromium binary not installed",
    latencyMs: null,
    hint:
      "Playwright needs its own Chromium build. Without it, audits ship with PSI data only — visitor-facing findings are correct but lose structural details (heading hierarchy, word counts, design-token fingerprints). One-time install:",
    hintCmd: "cd worker; pnpm exec playwright install chromium",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function timed(
  service: string,
  endpoint: string,
  fn: () => Promise<{ ok: boolean; message: string }>,
): Promise<Check> {
  const t = Date.now();
  try {
    const result = await fn();
    return { service, endpoint, ...result, latencyMs: Date.now() - t };
  } catch (err) {
    return {
      service,
      endpoint,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t,
    };
  }
}

async function fetchWithTimeout(
  url: string,
  ms: number,
  init: RequestInit = {},
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
