import "server-only";
import type { CostLedger, LedgerSnapshot } from "@/lib/models/cost-ledger";
import type { Purpose } from "@/lib/models/types";
import { getSupabaseAdminClient } from "./supabase/client";

/**
 * Supabase-backed CostLedger.
 *
 * All mutations go through atomic RPC functions defined in
 * supabase/migrations/0001_phase1_core.sql:
 *   - ledger_record_estimate(numeric)
 *   - ledger_record_actual(numeric, numeric)
 *   - ledger_record_blocked()
 *   - ledger_record_lite_swap()
 *
 * Reads (wouldExceed, snapshot) hit the cost_ledger table directly.
 *
 * If the Supabase client isn't configured at construction time, throws — the
 * factory in `src/server/model-router.ts` is responsible for choosing
 * MemoryCostLedger as the fallback BEFORE constructing this.
 */
export class SupabaseCostLedger implements CostLedger {
  private readonly capUsd: number;

  constructor(opts?: { capUsd?: number }) {
    this.capUsd = opts?.capUsd ?? Number(process.env.DAILY_COST_CAP_USD ?? 50);
    if (!getSupabaseAdminClient()) {
      throw new Error("SupabaseCostLedger requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    }
  }

  private client() {
    const c = getSupabaseAdminClient();
    if (!c) throw new Error("Supabase client unexpectedly null");
    return c;
  }

  async wouldExceed(estimatedCostUsd: number): Promise<boolean> {
    const snap = await this.snapshot();
    return snap.estimatedSpendUsd + estimatedCostUsd > this.capUsd;
  }

  async recordEstimate(estimatedCostUsd: number): Promise<void> {
    const { error } = await this.client().rpc("ledger_record_estimate", {
      p_estimated_cost: estimatedCostUsd,
    });
    if (error) throw new Error(`ledger_record_estimate: ${error.message}`);
  }

  async recordActual(actualCostUsd: number, estimatedCostUsd: number): Promise<void> {
    const { error } = await this.client().rpc("ledger_record_actual", {
      p_actual_cost: actualCostUsd,
      p_estimated_cost: estimatedCostUsd,
    });
    if (error) throw new Error(`ledger_record_actual: ${error.message}`);
  }

  async recordBlocked(_purpose: Purpose): Promise<void> {
    const { error } = await this.client().rpc("ledger_record_blocked", {});
    if (error) throw new Error(`ledger_record_blocked: ${error.message}`);
  }

  async recordLiteSwap(): Promise<void> {
    const { error } = await this.client().rpc("ledger_record_lite_swap", {});
    if (error) throw new Error(`ledger_record_lite_swap: ${error.message}`);
  }

  async snapshot(): Promise<LedgerSnapshot> {
    // cost_ledger.date is `current_date` in the DB — match here in UTC.
    const today = isoDateUtc();
    const { data, error } = await this.client()
      .from("cost_ledger")
      .select("*")
      .eq("date", today)
      .maybeSingle();
    if (error) throw new Error(`snapshot select: ${error.message}`);
    return {
      date: today,
      estimatedSpendUsd: Number(data?.estimated_spend ?? 0),
      actualSpendUsd: Number(data?.actual_spend ?? 0),
      callsMade: data?.calls_made ?? 0,
      callsBlocked: data?.calls_blocked ?? 0,
      liteModeSubstitutions: data?.lite_mode_substitutions ?? 0,
      capUsd: this.capUsd,
    };
  }
}

function isoDateUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
