import "server-only";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * Admin panel data fetchers — single source of truth for /admin/* reads.
 *
 * All functions accept the service-role client implicitly (via the singleton).
 * Every function gracefully returns empty / null when Supabase isn't
 * configured, so admin pages render a "Supabase not configured" empty state
 * rather than crashing.
 *
 * Phase 2 may move some of these to RPC functions (composite views over
 * multiple tables) — until then, plain table reads are fine.
 */

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardSnapshot {
  capUsd: number;
  todaySpendUsd: number;
  todayCallsMade: number;
  todayCallsBlocked: number;
  todayLiteSubstitutions: number;
  sessionsToday: number;
  sessionsThisWeek: number;
  sessionsYesterday: number;
  sessionsLastWeek: number;
  leadsCapturedToday: number;
  rateLimitedIpsToday: number;
  spendByDay: { date: string; usd: number }[]; // last 30 days
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const client = getSupabaseAdminClient();
  const capUsd = Number(process.env.DAILY_COST_CAP_USD ?? 50);

  if (!client) return emptyDashboardSnapshot(capUsd);

  const today = isoDate(0);
  const yesterday = isoDate(-1);
  const sevenDaysAgo = isoDate(-7);
  const fourteenDaysAgo = isoDate(-14);

  const [
    todayLedger,
    last30,
    sessionsTodayCount,
    sessionsYesterdayCount,
    sessionsThisWeekCount,
    sessionsLastWeekCount,
    leadsTodayCount,
    rateLimitedToday,
  ] = await Promise.all([
    client
      .from("cost_ledger")
      .select("actual_spend, estimated_spend, calls_made, calls_blocked, lite_mode_substitutions")
      .eq("date", today)
      .maybeSingle(),
    client
      .from("cost_ledger")
      .select("date, actual_spend")
      .gte("date", isoDate(-29))
      .order("date", { ascending: true }),
    countSessionsSince(client, today),
    countSessionsBetween(client, yesterday, today),
    countSessionsSince(client, sevenDaysAgo),
    countSessionsBetween(client, fourteenDaysAgo, sevenDaysAgo),
    countLeadsToday(client, today),
    countRateLimitedToday(client, today),
  ]);

  const ledger = (todayLedger.data ?? null) as
    | {
        actual_spend: number;
        estimated_spend: number;
        calls_made: number;
        calls_blocked: number;
        lite_mode_substitutions: number;
      }
    | null;

  return {
    capUsd,
    todaySpendUsd: Number(ledger?.actual_spend ?? 0),
    todayCallsMade: ledger?.calls_made ?? 0,
    todayCallsBlocked: ledger?.calls_blocked ?? 0,
    todayLiteSubstitutions: ledger?.lite_mode_substitutions ?? 0,
    sessionsToday: sessionsTodayCount,
    sessionsThisWeek: sessionsThisWeekCount,
    sessionsYesterday: sessionsYesterdayCount,
    sessionsLastWeek: sessionsLastWeekCount,
    leadsCapturedToday: leadsTodayCount,
    rateLimitedIpsToday: rateLimitedToday,
    spendByDay: ((last30.data ?? []) as { date: string; actual_spend: number }[]).map(
      (r) => ({ date: r.date, usd: Number(r.actual_spend) }),
    ),
  };
}

function emptyDashboardSnapshot(capUsd: number): DashboardSnapshot {
  return {
    capUsd,
    todaySpendUsd: 0,
    todayCallsMade: 0,
    todayCallsBlocked: 0,
    todayLiteSubstitutions: 0,
    sessionsToday: 0,
    sessionsThisWeek: 0,
    sessionsYesterday: 0,
    sessionsLastWeek: 0,
    leadsCapturedToday: 0,
    rateLimitedIpsToday: 0,
    spendByDay: [],
  };
}

// ---------------------------------------------------------------------------
// Recent sessions + opener queries (dashboard tail-lists)
// ---------------------------------------------------------------------------

export interface RecentSessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  terminalNode: string | null;
  visitorIndustry: string | null;
  submittedUrl: string | null;
  totalCostUsd: number;
  leadCaptured: boolean;
}

export async function listRecentSessions(limit = 50): Promise<RecentSessionRow[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  const { data, error } = await client
    .from("sessions")
    .select(
      "id, started_at, ended_at, terminal_node, visitor_industry, submitted_url, total_cost_usd, lead_captured",
    )
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return ((data ?? []) as Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    terminal_node: string | null;
    visitor_industry: string | null;
    submitted_url: string | null;
    total_cost_usd: number;
    lead_captured: boolean;
  }>).map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    terminalNode: r.terminal_node,
    visitorIndustry: r.visitor_industry,
    submittedUrl: r.submitted_url,
    totalCostUsd: Number(r.total_cost_usd),
    leadCaptured: r.lead_captured,
  }));
}

export interface RecentOpenerRow {
  sessionId: string;
  content: string;
  ts: string;
}

export async function listRecentOpeners(limit = 50): Promise<RecentOpenerRow[]> {
  const client = getSupabaseAdminClient();
  if (!client) return [];
  // First user message per session — we approximate via a single MIN(ts) per
  // session_id. SQL-side this is doable with a window function via RPC;
  // for Phase 1 we fetch the latest N user messages and dedupe in code.
  const { data, error } = await client
    .from("messages")
    .select("session_id, content, ts")
    .eq("role", "user")
    .order("ts", { ascending: false })
    .limit(limit * 3); // over-fetch so dedupe gives us ~limit unique sessions
  if (error) return [];
  const seen = new Set<string>();
  const out: RecentOpenerRow[] = [];
  for (const row of (data ?? []) as Array<{
    session_id: string;
    content: string;
    ts: string;
  }>) {
    if (seen.has(row.session_id)) continue;
    seen.add(row.session_id);
    out.push({ sessionId: row.session_id, content: row.content, ts: row.ts });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Paginated version of listRecentOpeners. Returns ~pageSize unique-session
 * opener messages plus a total-unique-sessions count for the page navigator.
 *
 * Why a second function instead of replacing the original: the embed widget
 * + Phase 2 features still want the raw "latest N openers" API. Keeping
 * both is cheap (the page-aware version overfetches a touch more to
 * compensate for cross-page dedupe edge cases).
 */
export interface PaginatedRecentOpeners {
  rows: RecentOpenerRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listRecentOpenersPaged(
  page: number,
  pageSize: number,
): Promise<PaginatedRecentOpeners> {
  const client = getSupabaseAdminClient();
  if (!client) return { rows: [], total: 0, page, pageSize };

  // Total unique sessions with a user message. Used by the paginator. We
  // count sessions with at least one user message rather than total
  // messages — the latter would over-count sessions with N visitor turns.
  const totalRes = await client
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .not("id", "is", null);
  const total = totalRes.count ?? 0;

  // Range-based pagination on the sorted-by-ts result. We overfetch by 2x
  // to give the in-memory deduper headroom; in practice each session has a
  // user-message ratio close to 1, so the actual fan-out is small.
  const overfetch = pageSize * 3;
  const offset = (page - 1) * pageSize;
  const { data, error } = await client
    .from("messages")
    .select("session_id, content, ts")
    .eq("role", "user")
    .order("ts", { ascending: false })
    .range(offset, offset + overfetch - 1);
  if (error) return { rows: [], total, page, pageSize };

  const seen = new Set<string>();
  const rows: RecentOpenerRow[] = [];
  for (const row of (data ?? []) as Array<{
    session_id: string;
    content: string;
    ts: string;
  }>) {
    if (seen.has(row.session_id)) continue;
    seen.add(row.session_id);
    rows.push({ sessionId: row.session_id, content: row.content, ts: row.ts });
    if (rows.length >= pageSize) break;
  }
  return { rows, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// /admin/sessions table
// ---------------------------------------------------------------------------

export interface SessionFilters {
  /** ISO date inclusive. */
  startDate?: string;
  /** ISO date inclusive. */
  endDate?: string;
  terminalNode?: "output" | "cap_reached" | "abandoned" | "rate_limited" | "all";
  hasUrl?: "yes" | "no" | "all";
  leadCaptured?: "yes" | "no" | "all";
  page?: number;
  pageSize?: number;
}

export interface SessionsPage {
  rows: RecentSessionRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listSessions(filters: SessionFilters = {}): Promise<SessionsPage> {
  const client = getSupabaseAdminClient();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, filters.pageSize ?? 50));
  if (!client) return { rows: [], total: 0, page, pageSize };

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = client
    .from("sessions")
    .select(
      "id, started_at, ended_at, terminal_node, visitor_industry, submitted_url, total_cost_usd, lead_captured",
      { count: "exact" },
    )
    .order("started_at", { ascending: false })
    .range(from, to);

  if (filters.startDate) q = q.gte("started_at", `${filters.startDate}T00:00:00Z`);
  if (filters.endDate) q = q.lte("started_at", `${filters.endDate}T23:59:59Z`);
  if (filters.terminalNode && filters.terminalNode !== "all") {
    q = q.eq("terminal_node", filters.terminalNode);
  }
  if (filters.hasUrl === "yes") q = q.not("submitted_url", "is", null);
  if (filters.hasUrl === "no") q = q.is("submitted_url", null);
  if (filters.leadCaptured === "yes") q = q.eq("lead_captured", true);
  if (filters.leadCaptured === "no") q = q.eq("lead_captured", false);

  const { data, error, count } = await q;
  if (error) return { rows: [], total: 0, page, pageSize };

  const rows = ((data ?? []) as Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    terminal_node: string | null;
    visitor_industry: string | null;
    submitted_url: string | null;
    total_cost_usd: number;
    lead_captured: boolean;
  }>).map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    terminalNode: r.terminal_node,
    visitorIndustry: r.visitor_industry,
    submittedUrl: r.submitted_url,
    totalCostUsd: Number(r.total_cost_usd),
    leadCaptured: r.lead_captured,
  }));

  return { rows, total: count ?? rows.length, page, pageSize };
}

// ---------------------------------------------------------------------------
// /admin/sessions/[id]
// ---------------------------------------------------------------------------

export interface SessionDetail {
  session: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    terminalNode: string | null;
    visitorIndustry: string | null;
    visitorRole: string | null;
    visitorNamedProblem: string | null;
    submittedUrl: string | null;
    leadCaptured: boolean;
    totalCostUsd: number;
    ipHash: string | null;
    userAgent: string | null;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    emittedByNode: string | null;
    ts: string;
  }>;
  modelCalls: Array<{
    id: string;
    node: string | null;
    provider: string;
    model: string;
    purpose: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number;
    latencyMs: number | null;
    wasBlocked: boolean;
    ts: string;
    requestPayload: unknown;
    responsePayload: unknown;
  }>;
  uiActions: Array<{
    id: string;
    actionType: string;
    actionId: string;
    ts: string;
  }>;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const client = getSupabaseAdminClient();
  if (!client) return null;
  const [sessionRes, messagesRes, callsRes, uiRes] = await Promise.all([
    client.from("sessions").select("*").eq("id", sessionId).maybeSingle(),
    client.from("messages").select("*").eq("session_id", sessionId).order("ts", { ascending: true }),
    client
      .from("model_calls")
      .select("*")
      .eq("session_id", sessionId)
      .order("ts", { ascending: true }),
    client
      .from("ui_actions_emitted")
      .select("id, action_id, action_type, ts")
      .eq("session_id", sessionId)
      .order("ts", { ascending: true }),
  ]);

  if (!sessionRes.data) return null;
  const s = sessionRes.data as {
    id: string;
    started_at: string;
    ended_at: string | null;
    terminal_node: string | null;
    visitor_industry: string | null;
    visitor_role: string | null;
    visitor_named_problem: string | null;
    submitted_url: string | null;
    lead_captured: boolean;
    total_cost_usd: number;
    ip_hash: string | null;
    user_agent: string | null;
  };

  return {
    session: {
      id: s.id,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      terminalNode: s.terminal_node,
      visitorIndustry: s.visitor_industry,
      visitorRole: s.visitor_role,
      visitorNamedProblem: s.visitor_named_problem,
      submittedUrl: s.submitted_url,
      leadCaptured: s.lead_captured,
      totalCostUsd: Number(s.total_cost_usd),
      ipHash: s.ip_hash,
      userAgent: s.user_agent,
    },
    messages: ((messagesRes.data ?? []) as Array<{
      id: string;
      role: string;
      content: string;
      emitted_by_node: string | null;
      ts: string;
    }>).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      emittedByNode: m.emitted_by_node,
      ts: m.ts,
    })),
    modelCalls: ((callsRes.data ?? []) as Array<{
      id: string;
      node: string | null;
      provider: string;
      model: string;
      purpose: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: number;
      latency_ms: number | null;
      was_blocked: boolean;
      ts: string;
      request_payload: unknown;
      response_payload: unknown;
    }>).map((c) => ({
      id: c.id,
      node: c.node,
      provider: c.provider,
      model: c.model,
      purpose: c.purpose,
      inputTokens: c.input_tokens,
      outputTokens: c.output_tokens,
      costUsd: Number(c.cost_usd),
      latencyMs: c.latency_ms,
      wasBlocked: c.was_blocked,
      ts: c.ts,
      requestPayload: c.request_payload,
      responsePayload: c.response_payload,
    })),
    uiActions: ((uiRes.data ?? []) as Array<{
      id: string;
      action_id: string;
      action_type: string;
      ts: string;
    }>).map((u) => ({
      id: u.id,
      actionId: u.action_id,
      actionType: u.action_type,
      ts: u.ts,
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function countSessionsSince(
  client: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  sinceDate: string,
): Promise<number> {
  const { count } = await client
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .gte("started_at", `${sinceDate}T00:00:00Z`);
  return count ?? 0;
}

async function countSessionsBetween(
  client: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  fromDate: string,
  toDateExclusive: string,
): Promise<number> {
  const { count } = await client
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .gte("started_at", `${fromDate}T00:00:00Z`)
    .lt("started_at", `${toDateExclusive}T00:00:00Z`);
  return count ?? 0;
}

async function countLeadsToday(
  client: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  today: string,
): Promise<number> {
  const [{ count: sessLeads }, { count: waitlistLeads }] = await Promise.all([
    client
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .gte("started_at", `${today}T00:00:00Z`)
      .eq("lead_captured", true),
    client
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .gte("captured_at", `${today}T00:00:00Z`),
  ]);
  return (sessLeads ?? 0) + (waitlistLeads ?? 0);
}

async function countRateLimitedToday(
  client: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  today: string,
): Promise<number> {
  const turnLimit = Number(process.env.IP_DAILY_TURN_LIMIT ?? 20);
  const auditLimit = Number(process.env.IP_DAILY_AUDIT_LIMIT ?? 1);
  const { data } = await client
    .from("ip_quota")
    .select("ip_hash, turns_used, audits_used")
    .eq("date", today);
  if (!data) return 0;
  let n = 0;
  for (const row of data as Array<{ ip_hash: string; turns_used: number; audits_used: number }>) {
    if (row.turns_used >= turnLimit || row.audits_used >= auditLimit) n++;
  }
  return n;
}
