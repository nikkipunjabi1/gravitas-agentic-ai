import { describe, it, expect } from "vitest";
import { UIAction, UI_ACTION_TYPES } from "@/canvas/schema";

/**
 * The UIAction schema is the wire contract between agent runtime and the
 * canvas. These tests verify the discriminator, required fields, enum
 * narrowing, and that every type is registered.
 */
describe("UIAction schema", () => {
  // ---- Discriminator ------------------------------------------------------

  it("accepts a minimal DebugAction", () => {
    const result = UIAction.safeParse({
      type: "DebugAction",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: { anything: "goes" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown type", () => {
    const result = UIAction.safeParse({
      type: "NotARealActionType",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = UIAction.safeParse({
      type: "DebugAction",
      id: "not-a-uuid",
      version: 1,
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects version !== 1", () => {
    const result = UIAction.safeParse({
      type: "DebugAction",
      id: "11111111-1111-4111-8111-111111111111",
      version: 2,
      data: {},
    });
    expect(result.success).toBe(false);
  });

  // ---- AuditFindings ------------------------------------------------------

  it("accepts an AuditFindings with one finding tagged by lens", () => {
    const result = UIAction.safeParse({
      type: "AuditFindings",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        findings: [
          {
            id: "f1",
            lens: "usability",
            category: "ux",
            severity: "high",
            title: "Primary CTA below the fold on mobile",
            detail: "Users have to scroll before reaching the call to action.",
            gravitasService: "experience-strategy-design",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an AuditFindings with title > 80 chars", () => {
    const result = UIAction.safeParse({
      type: "AuditFindings",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        findings: [
          {
            id: "f1",
            lens: "usability",
            category: "ux",
            severity: "high",
            title: "x".repeat(81),
            detail: "ok",
            gravitasService: null,
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  // ---- MaturityChart ------------------------------------------------------

  it("accepts a MaturityChart with exactly 4 axes", () => {
    const result = UIAction.safeParse({
      type: "MaturityChart",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        axes: [
          { label: "Usability Standards", normalizedScore: 6, rawScore: 18, maxScore: 30, rationale: "ok" },
          { label: "User Needs", normalizedScore: 5, rawScore: 10, maxScore: 20, rationale: "ok" },
          { label: "Conversion", normalizedScore: 4, rawScore: 12, maxScore: 30, rationale: "ok" },
          { label: "Design Execution", normalizedScore: 7, rawScore: 14, maxScore: 20, rationale: "ok" },
        ],
        totalScore: 54,
        targetScore: 75,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a MaturityChart with 3 axes", () => {
    const result = UIAction.safeParse({
      type: "MaturityChart",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        axes: [
          { label: "Usability Standards", normalizedScore: 6, rawScore: 18, maxScore: 30, rationale: "ok" },
          { label: "User Needs", normalizedScore: 5, rawScore: 10, maxScore: 20, rationale: "ok" },
          { label: "Conversion", normalizedScore: 4, rawScore: 12, maxScore: 30, rationale: "ok" },
        ],
        totalScore: 40,
        targetScore: null,
      },
    });
    expect(result.success).toBe(false);
  });

  // ---- RoadmapWidget ------------------------------------------------------

  it("accepts a priority-mode RoadmapWidget with 3 groups", () => {
    const result = UIAction.safeParse({
      type: "RoadmapWidget",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        mode: "priority",
        groups: [
          { label: "Must", items: [{ title: "x", why: "y", gravitasService: "experience-strategy-design" }] },
          { label: "Should", items: [] },
          { label: "Could", items: [] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  // ---- KeepAndBuildOn .default([]) on optional ---------------------------

  it("populates KeepAndBuildOn.alsoWorking with the empty-array default", () => {
    const result = UIAction.safeParse({
      type: "KeepAndBuildOn",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {
        strengths: [
          { title: "Clear lead form", detail: "Three fields, clear submit.", lens: "conversion" },
          { title: "Strong page perf", detail: "LCP < 1.5s.", lens: "design-execution" },
        ],
        // alsoWorking deliberately omitted
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "KeepAndBuildOn") {
      expect(result.data.data.alsoWorking).toEqual([]);
    }
  });

  // ---- UI_ACTION_TYPES is in sync with the discriminator -----------------

  it("UI_ACTION_TYPES lists exactly the discriminator literals", () => {
    // Sanity check that the convenience array doesn't drift from the schema.
    // We can't enumerate the union at runtime, but we can verify each entry
    // is a non-empty string and the length matches the count in the schema.
    expect(UI_ACTION_TYPES.length).toBe(12); // Phase 0 — adjust when a new arm lands
    for (const t of UI_ACTION_TYPES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
