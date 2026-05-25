import { describe, it, expect } from "vitest";
import {
  costOfCall,
  estimateCallCost,
  estimateInputTokens,
  KNOWN_ANTHROPIC_MODELS,
} from "@/lib/models/pricing";

describe("pricing", () => {
  it("registers Sonnet 4.6 and Haiku 4.5", () => {
    expect(KNOWN_ANTHROPIC_MODELS).toContain("claude-sonnet-4-6");
    expect(KNOWN_ANTHROPIC_MODELS).toContain("claude-haiku-4-5-20251001");
  });

  it("computes Sonnet 4.6 cost at $3/$15 per 1M", () => {
    // 1M input + 1M output should be $3 + $15 = $18.
    const cost = costOfCall({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it("computes Haiku 4.5 cost at $1/$5 per 1M", () => {
    const cost = costOfCall({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 6);
  });

  it("estimateCallCost assumes worst-case output (maxOutputTokens billed at output rate)", () => {
    const est = estimateCallCost({
      model: "claude-sonnet-4-6",
      inputTokens: 500_000,
      maxOutputTokens: 200_000,
    });
    // 0.5M * $3 + 0.2M * $15 = 1.5 + 3.0 = 4.5
    expect(est).toBeCloseTo(4.5, 6);
  });

  it("throws on an unknown model (forces us to update pricing.ts)", () => {
    expect(() =>
      costOfCall({
        model: "claude-imaginary-9000",
        inputTokens: 100,
        outputTokens: 100,
      }),
    ).toThrow(/no rates registered/);
  });

  it("estimateInputTokens uses the 4-char-per-token rule of thumb", () => {
    const messages = [
      { role: "user", content: "x".repeat(40) }, // 10 tokens
      { role: "assistant", content: "y".repeat(20) }, // 5 tokens
    ];
    // 60 chars / 4 = 15. ceil() makes that exact for this input.
    expect(estimateInputTokens(messages)).toBe(15);
  });
});
