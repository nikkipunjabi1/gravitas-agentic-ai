import "server-only";
import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/server/supabase/client";

/**
 * Per-IP daily quota (anti-abuse).
 *
 * Two counters, both reset at 00:00 UTC:
 *   - turns_used  vs IP_DAILY_TURN_LIMIT  (default 20)
 *   - audits_used vs IP_DAILY_AUDIT_LIMIT (default 1)
 *
 * IP identity is hashed via sha256(ip + SESSION_SIGNING_SECRET) — we NEVER
 * store raw IPs. The same visitor across a day hashes to the same key; a
 * different visitor on the same NAT gets a different key (because IP differs).
 *
 * Storage: Supabase ip_quota table + atomic RPCs (quota_consume_turn,
 * quota_consume_audit, quota_get). When Supabase isn't configured, falls
 * back to an in-memory Map keyed by (ipHash, date) — fine for dev, but
 * the counters reset on every server restart.
 *
 * See docs/ARCHITECTURE.md → Rate limiting.
 */

export interface QuotaResult {
  accepted: boolean;
  turnsRemaining: number;
  auditsRemaining: number;
}

const TURN_LIMIT = Number(process.env.IP_DAILY_TURN_LIMIT ?? 20);
const AUDIT_LIMIT = Number(process.env.IP_DAILY_AUDIT_LIMIT ?? 1);

/**
 * Dev bypass — the quota is anti-abuse for production traffic. On a local
 * `pnpm dev` machine, capping the developer at 20 turns/day is hostile.
 *
 *   NODE_ENV !== "production"           → bypass
 *   IP_QUOTA_FORCE_ENFORCE=true         → opt back in (useful for testing
 *                                         the rate-limit code path itself)
 *
 * In production, NODE_ENV is "production" (set by Next/Railway), so the
 * bypass never fires.
 */
const QUOTA_BYPASSED =
  process.env.NODE_ENV !== "production" &&
  process.env.IP_QUOTA_FORCE_ENFORCE !== "true";

export function getLimits(): { turnLimit: number; auditLimit: number } {
  return { turnLimit: TURN_LIMIT, auditLimit: AUDIT_LIMIT };
}

export function isQuotaBypassed(): boolean {
  return QUOTA_BYPASSED;
}

/**
 * Hash an IP into a pseudonymous key. Falls back to a deterministic
 * "unknown" hash when no secret is configured AND no IP was supplied — this
 * keeps dev running but means quota is shared across all dev visitors.
 */
export function hashIp(ip: string | null | undefined): string {
  const secret = process.env.SESSION_SIGNING_SECRET ?? "";
  if (!secret) {
    // eslint-disable-next-line no-console
    console.warn(
      "[ip-quota] SESSION_SIGNING_SECRET not set — IP hashes use a development fallback",
    );
  }
  const safeIp = ip && ip.length > 0 ? ip : "unknown";
  return createHash("sha256").update(safeIp).update(secret).digest("hex");
}

/** Extract the client IP from a Request — handles Vercel/Railway/Cloudflare headers. */
export function extractIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    // First entry is the original client; subsequent entries are proxy hops.
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function consumeTurn(ipHash: string): Promise<QuotaResult> {
  if (QUOTA_BYPASSED) {
    // Dev bypass — return accepted without touching the DB so a single
    // /api/chat compile doesn't burn a turn.
    return { accepted: true, turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT };
  }
  const client = getSupabaseAdminClient();
  if (client) {
    const { data, error } = await client.rpc("quota_consume_turn", {
      p_ip_hash: ipHash,
      p_limit: TURN_LIMIT,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[ip-quota] quota_consume_turn failed", error.message);
      // Fail open in case of DB outage — we'd rather serve users than block
      // them on a transient infra issue. The cost cap is the backstop.
      return { accepted: true, turnsRemaining: TURN_LIMIT - 1, auditsRemaining: AUDIT_LIMIT };
    }
    const row = data?.[0];
    if (!row) {
      return { accepted: true, turnsRemaining: TURN_LIMIT - 1, auditsRemaining: AUDIT_LIMIT };
    }
    return {
      accepted: row.accepted,
      turnsRemaining: Math.max(0, TURN_LIMIT - row.turns_used),
      auditsRemaining: Math.max(0, AUDIT_LIMIT - row.audits_used),
    };
  }
  return memoryConsume(ipHash, "turns", TURN_LIMIT, AUDIT_LIMIT);
}

export async function consumeAudit(ipHash: string): Promise<QuotaResult> {
  if (QUOTA_BYPASSED) {
    return { accepted: true, turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT };
  }
  const client = getSupabaseAdminClient();
  if (client) {
    const { data, error } = await client.rpc("quota_consume_audit", {
      p_ip_hash: ipHash,
      p_limit: AUDIT_LIMIT,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[ip-quota] quota_consume_audit failed", error.message);
      return { accepted: true, turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT - 1 };
    }
    const row = data?.[0];
    if (!row) {
      return { accepted: true, turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT - 1 };
    }
    return {
      accepted: row.accepted,
      turnsRemaining: Math.max(0, TURN_LIMIT - row.turns_used),
      auditsRemaining: Math.max(0, AUDIT_LIMIT - row.audits_used),
    };
  }
  return memoryConsume(ipHash, "audits", TURN_LIMIT, AUDIT_LIMIT);
}

export async function getQuota(
  ipHash: string,
): Promise<{ turnsRemaining: number; auditsRemaining: number }> {
  const client = getSupabaseAdminClient();
  if (client) {
    const { data, error } = await client.rpc("quota_get", { p_ip_hash: ipHash });
    if (error) {
      return { turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT };
    }
    const row = data?.[0];
    if (!row) return { turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT };
    return {
      turnsRemaining: Math.max(0, TURN_LIMIT - row.turns_used),
      auditsRemaining: Math.max(0, AUDIT_LIMIT - row.audits_used),
    };
  }
  const row = memoryRows.get(memoryKey(ipHash));
  if (!row) return { turnsRemaining: TURN_LIMIT, auditsRemaining: AUDIT_LIMIT };
  return {
    turnsRemaining: Math.max(0, TURN_LIMIT - row.turns),
    auditsRemaining: Math.max(0, AUDIT_LIMIT - row.audits),
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev only)
//
// Keyed by `${ipHash}|${date}`. Resets on process restart and at UTC midnight
// (because new dates produce new keys; old keys leak — fine for a process
// that restarts at dev cadence).
// ---------------------------------------------------------------------------

const memoryRows = new Map<string, { turns: number; audits: number }>();

function memoryKey(ipHash: string): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${ipHash}|${date}`;
}

function memoryConsume(
  ipHash: string,
  which: "turns" | "audits",
  turnLimit: number,
  auditLimit: number,
): QuotaResult {
  const key = memoryKey(ipHash);
  const row = memoryRows.get(key) ?? { turns: 0, audits: 0 };
  const limit = which === "turns" ? turnLimit : auditLimit;
  const used = which === "turns" ? row.turns : row.audits;
  if (used >= limit) {
    return {
      accepted: false,
      turnsRemaining: Math.max(0, turnLimit - row.turns),
      auditsRemaining: Math.max(0, auditLimit - row.audits),
    };
  }
  if (which === "turns") row.turns = used + 1;
  else row.audits = used + 1;
  memoryRows.set(key, row);
  return {
    accepted: true,
    turnsRemaining: Math.max(0, turnLimit - row.turns),
    auditsRemaining: Math.max(0, auditLimit - row.audits),
  };
}
