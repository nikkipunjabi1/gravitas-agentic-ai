import type { Purpose } from "./types";

/**
 * Daily cost-ledger interface.
 *
 * Phase 0 ships an in-memory implementation (`MemoryCostLedger`). Phase 1
 * swaps it for a Supabase-backed one that reads/writes the `cost_ledger`
 * table (see docs/ARCHITECTURE.md → Cost cap → Storage). The router accepts
 * any implementation that satisfies this interface — agent code stays
 * stable across the swap.
 *
 * Invariants the router relies on:
 *   - `wouldExceed` is the SOLE authority on cap state. It returns true if
 *     adding `estimatedCostUsd` to today's row would breach the cap.
 *   - `recordEstimate` is called BEFORE the provider call. If the call
 *     succeeds, `recordActual` reconciles.
 *   - `recordBlocked` is called when a voice-heavy call is refused.
 *   - `recordLiteSwap` is called when voice-light silently swaps to Ollama.
 */
export interface CostLedger {
  /** Returns true if adding `estimatedCostUsd` would breach today's cap. */
  wouldExceed(estimatedCostUsd: number): Promise<boolean>;

  /** Records a pre-flight estimate (call is about to happen). */
  recordEstimate(estimatedCostUsd: number): Promise<void>;

  /** Reconciles a successful call against the estimate. */
  recordActual(actualCostUsd: number, estimatedCostUsd: number): Promise<void>;

  /** Records a refused voice-heavy call (no provider call made). */
  recordBlocked(purpose: Purpose): Promise<void>;

  /** Records a voice-light → Ollama silent swap. */
  recordLiteSwap(): Promise<void>;

  /** Returns today's snapshot — used by the admin dashboard and tests. */
  snapshot(): Promise<LedgerSnapshot>;
}

export interface LedgerSnapshot {
  date: string; // YYYY-MM-DD, in COST_CAP_RESET_TZ
  estimatedSpendUsd: number;
  actualSpendUsd: number;
  callsMade: number;
  callsBlocked: number;
  liteModeSubstitutions: number;
  capUsd: number;
}

// ---------------------------------------------------------------------------
// In-memory implementation — Phase 0.
//
// Resets on process restart. Perfectly fine for dev / smoke; Phase 1 replaces
// with a Supabase-backed implementation in src/server/cost-ledger-supabase.ts.
// ---------------------------------------------------------------------------

interface DayRow {
  date: string;
  estimatedSpendUsd: number;
  actualSpendUsd: number;
  callsMade: number;
  callsBlocked: number;
  liteModeSubstitutions: number;
}

export class MemoryCostLedger implements CostLedger {
  private readonly capUsd: number;
  private readonly tz: string;
  private rows = new Map<string, DayRow>();

  constructor(opts?: { capUsd?: number; tz?: string }) {
    this.capUsd = opts?.capUsd ?? Number(process.env.DAILY_COST_CAP_USD ?? 50);
    this.tz = opts?.tz ?? process.env.COST_CAP_RESET_TZ ?? "UTC";
  }

  private today(): string {
    // YYYY-MM-DD in the configured TZ. We use Intl.DateTimeFormat to avoid a
    // tzdata dep at this layer; production swap to date-fns-tz if precision
    // around DST boundaries matters.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date());
  }

  private row(): DayRow {
    const date = this.today();
    let row = this.rows.get(date);
    if (!row) {
      row = {
        date,
        estimatedSpendUsd: 0,
        actualSpendUsd: 0,
        callsMade: 0,
        callsBlocked: 0,
        liteModeSubstitutions: 0,
      };
      this.rows.set(date, row);
    }
    return row;
  }

  async wouldExceed(estimatedCostUsd: number): Promise<boolean> {
    const row = this.row();
    return row.estimatedSpendUsd + estimatedCostUsd > this.capUsd;
  }

  async recordEstimate(estimatedCostUsd: number): Promise<void> {
    const row = this.row();
    row.estimatedSpendUsd += estimatedCostUsd;
    row.callsMade += 1;
  }

  async recordActual(actualCostUsd: number, estimatedCostUsd: number): Promise<void> {
    const row = this.row();
    // Adjust the estimate to match reality. Net effect: actualSpendUsd reflects
    // truth; estimatedSpendUsd converges to it.
    row.actualSpendUsd += actualCostUsd;
    row.estimatedSpendUsd += actualCostUsd - estimatedCostUsd;
  }

  async recordBlocked(_purpose: Purpose): Promise<void> {
    const row = this.row();
    row.callsBlocked += 1;
  }

  async recordLiteSwap(): Promise<void> {
    const row = this.row();
    row.liteModeSubstitutions += 1;
  }

  async snapshot(): Promise<LedgerSnapshot> {
    const row = this.row();
    return { ...row, capUsd: this.capUsd };
  }
}

/**
 * Module-level singleton. The router imports `defaultCostLedger` so test
 * harnesses can override by constructing their own router with a different
 * ledger (Phase 1 does this for Supabase).
 */
export const defaultCostLedger: CostLedger = new MemoryCostLedger();
