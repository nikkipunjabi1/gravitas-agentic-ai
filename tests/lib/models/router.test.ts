import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ModelRouter,
  MemoryCostLedger,
  NoopCallLog,
  DailyCapExceeded,
  NoProviderAvailable,
} from "@/lib/models";

/**
 * Router decision tests — Phase 0 scope.
 *
 * Focus: the throw paths (cap-hit voice-heavy, missing-key voice-heavy). These
 * exercise `decide()` synchronously and don't need any provider mock — the
 * router throws before calling Anthropic or Ollama.
 *
 * The lite-swap-to-Ollama paths (voice-light + cap, voice-light + no key) call
 * Ollama for real, so they need a provider mock to test fully. That mock lives
 * in Phase 1 along with the rest of the agent test scaffolding.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env so one test's mutation doesn't bleed into the next.
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  // Default: assume key is present for the cap-hit tests. Individual tests
  // override.
  process.env.ANTHROPIC_API_KEY = "sk-test-fixture";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
  process.env.DAILY_COST_CAP_USD = "50";
});

describe("ModelRouter.complete — cap-hit on voice-heavy", () => {
  it("throws DailyCapExceeded when the ledger is saturated", async () => {
    const ledger = new MemoryCostLedger({ capUsd: 50 });
    // Pre-fill the ledger with $49.99 of estimated spend. Any non-trivial
    // voice-heavy call (default max output 2048 tokens of Sonnet at $15/M =
    // $0.03072) pushes us over.
    await ledger.recordEstimate(49.99);

    const router = new ModelRouter(ledger, new NoopCallLog());
    let caught: unknown = null;
    try {
      await router.complete({
        purpose: "voice-heavy",
        messages: [{ role: "user", content: "Synthesize an audit narration." }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DailyCapExceeded);
    if (caught instanceof DailyCapExceeded) {
      expect(caught.purpose).toBe("voice-heavy");
      expect(caught.capUsd).toBe(50);
      expect(caught.estimatedCostUsd).toBeGreaterThan(0);
    }
  });

  it("records a blocked attempt in the ledger", async () => {
    const ledger = new MemoryCostLedger({ capUsd: 50 });
    await ledger.recordEstimate(49.99);
    const router = new ModelRouter(ledger, new NoopCallLog());

    await router
      .complete({
        purpose: "voice-heavy",
        messages: [{ role: "user", content: "x" }],
      })
      .catch(() => undefined);

    const snap = await ledger.snapshot();
    expect(snap.callsBlocked).toBe(1);
  });
});

describe("ModelRouter.complete — voice-heavy with no Anthropic key", () => {
  it("throws NoProviderAvailable (Haiku is NOT an acceptable substitute for heavy)", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const router = new ModelRouter(new MemoryCostLedger(), new NoopCallLog());
    let caught: unknown = null;
    try {
      await router.complete({
        purpose: "voice-heavy",
        messages: [{ role: "user", content: "x" }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoProviderAvailable);
    if (caught instanceof NoProviderAvailable) {
      expect(caught.purpose).toBe("voice-heavy");
      expect(caught.attempts).toEqual(["anthropic (no key)"]);
    }
  });
});

describe("MemoryCostLedger — basic accounting", () => {
  it("wouldExceed flips after the cap is reached", async () => {
    const ledger = new MemoryCostLedger({ capUsd: 1 });
    expect(await ledger.wouldExceed(0.5)).toBe(false);
    await ledger.recordEstimate(0.5);
    expect(await ledger.wouldExceed(0.51)).toBe(true);
    expect(await ledger.wouldExceed(0.49)).toBe(false);
  });

  it("recordActual converges estimatedSpend toward actualSpend", async () => {
    const ledger = new MemoryCostLedger({ capUsd: 50 });
    await ledger.recordEstimate(1.0);
    await ledger.recordActual(0.75, 1.0); // we estimated $1, real was $0.75
    const snap = await ledger.snapshot();
    expect(snap.actualSpendUsd).toBeCloseTo(0.75, 6);
    expect(snap.estimatedSpendUsd).toBeCloseTo(0.75, 6); // 1.0 + (0.75 - 1.0)
  });

  it("counts callsBlocked and liteModeSubstitutions independently", async () => {
    const ledger = new MemoryCostLedger();
    await ledger.recordBlocked("voice-heavy");
    await ledger.recordBlocked("voice-heavy");
    await ledger.recordLiteSwap();
    const snap = await ledger.snapshot();
    expect(snap.callsBlocked).toBe(2);
    expect(snap.liteModeSubstitutions).toBe(1);
  });
});
