import "server-only";
import { getSupabaseAdminClient } from "./supabase/client";

/**
 * Session lifecycle — Phase 1.
 *
 * One row per visitor session. Lifecycle:
 *   1. createSession()           — first turn lands here
 *   2. appendMessage() * N        — user + assistant turns
 *   3. updateSessionVisitor()    — Discovery node fills industry/role/etc.
 *   4. endSession()              — graph reaches a terminal node
 *
 * Graceful degradation: when Supabase isn't configured, these functions are
 * no-ops (createSession still returns a synthetic uuid so the rest of the
 * code carries on). Logged warnings on first use so a misconfigured prod
 * doesn't fail silently.
 */

let warnedNotConfigured = false;

function warnOnce(): void {
  if (warnedNotConfigured) return;
  warnedNotConfigured = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[sessions] Supabase not configured — session rows will not be persisted. " +
      "Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable.",
  );
}

export interface EnsureSessionInput {
  /** Pre-existing session id (from the client). When omitted, a new UUID is minted. */
  id?: string;
  ipHash?: string | null;
  userAgent?: string | null;
}

/**
 * Ensure a `sessions` row exists for the given id (idempotent upsert).
 *
 * Why upsert vs plain insert: the client supplies a sessionStorage-backed
 * UUID, so the same id arrives on every turn of a session. Plain insert
 * would 23505 on turns 2+; ignoreDuplicates makes the call safe to run on
 * every turn. Net effect: turn 1 creates the row, turns 2+ are no-ops.
 *
 * This is the single create-or-touch primitive. The chat route calls it
 * BEFORE any `appendMessage` / model_call write, guaranteeing the FK is
 * satisfied.
 */
export async function ensureSession(input: EnsureSessionInput = {}): Promise<{ id: string }> {
  const id = input.id ?? crypto.randomUUID();
  const client = getSupabaseAdminClient();
  if (!client) {
    warnOnce();
    return { id };
  }
  const { error } = await client.from("sessions").upsert(
    {
      id,
      ip_hash: input.ipHash ?? null,
      user_agent: input.userAgent ?? null,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sessions] ensureSession failed", error.message);
  }
  return { id };
}

/** @deprecated — use ensureSession. Kept temporarily for any external caller. */
export const createSession = ensureSession;
export type CreateSessionInput = EnsureSessionInput;

export interface AppendMessageInput {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  emittedByNode?: string | null;
}

export async function appendMessage(input: AppendMessageInput): Promise<void> {
  const client = getSupabaseAdminClient();
  if (!client) {
    warnOnce();
    return;
  }
  const { error } = await client.from("messages").insert({
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    emitted_by_node: input.emittedByNode ?? null,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sessions] appendMessage failed", error.message);
  }
}

export interface UpdateSessionVisitorInput {
  sessionId: string;
  industry?: string | null;
  role?: string | null;
  namedProblem?: string | null;
  submittedUrl?: string | null;
}

export async function updateSessionVisitor(input: UpdateSessionVisitorInput): Promise<void> {
  const client = getSupabaseAdminClient();
  if (!client) {
    warnOnce();
    return;
  }
  const patch: Record<string, string | null | undefined> = {};
  if (input.industry !== undefined) patch.visitor_industry = input.industry;
  if (input.role !== undefined) patch.visitor_role = input.role;
  if (input.namedProblem !== undefined) patch.visitor_named_problem = input.namedProblem;
  if (input.submittedUrl !== undefined) patch.submitted_url = input.submittedUrl;
  if (Object.keys(patch).length === 0) return;
  const { error } = await client.from("sessions").update(patch).eq("id", input.sessionId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sessions] updateSessionVisitor failed", error.message);
  }
}

export interface SessionMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
  emittedByNode: string | null;
}

/**
 * Read all messages for a session in chronological order. Used by the
 * end-user chat-resume path (`GET /api/chat/history`) — NOT by the admin
 * panel (which has its own richer query). Returns an empty array when the
 * session is unknown or Supabase isn't configured.
 *
 * No FK lookup on `sessions` here — if a stale id arrives from a browser
 * that hasn't visited in a while and the row was GC'd, we just return [].
 */
export async function listSessionMessages(
  sessionId: string,
): Promise<SessionMessageRow[]> {
  const client = getSupabaseAdminClient();
  if (!client) {
    warnOnce();
    return [];
  }
  const { data, error } = await client
    .from("messages")
    .select("id, role, content, ts, emitted_by_node")
    .eq("session_id", sessionId)
    .order("ts", { ascending: true });
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sessions] listSessionMessages failed", error.message);
    return [];
  }
  if (!data) return [];
  return data
    .filter((row): row is { id: string; role: string; content: string; ts: string; emitted_by_node: string | null } =>
      row !== null && (row.role === "user" || row.role === "assistant"),
    )
    .map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      content: row.content,
      ts: row.ts,
      emittedByNode: row.emitted_by_node,
    }));
}

export interface EndSessionInput {
  sessionId: string;
  terminalNode: "output" | "cap_reached" | "abandoned" | "rate_limited";
  totalCostUsd?: number;
  leadCaptured?: boolean;
}

export async function endSession(input: EndSessionInput): Promise<void> {
  const client = getSupabaseAdminClient();
  if (!client) {
    warnOnce();
    return;
  }
  const patch: Record<string, unknown> = {
    ended_at: new Date().toISOString(),
    terminal_node: input.terminalNode,
  };
  if (input.totalCostUsd !== undefined) patch.total_cost_usd = input.totalCostUsd;
  if (input.leadCaptured !== undefined) patch.lead_captured = input.leadCaptured;
  const { error } = await client.from("sessions").update(patch).eq("id", input.sessionId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sessions] endSession failed", error.message);
  }
}
