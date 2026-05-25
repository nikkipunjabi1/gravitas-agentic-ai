import { describe, it, expect } from "vitest";
import {
  heuristicIntent,
  extractVisitorPatchHeuristic,
} from "@/agents/nodes/discovery";
import type { VisitorContext } from "@/agents/state";

/**
 * Discovery — Phase 1.3 unit tests.
 *
 * We test the deterministic helpers (heuristic intent, visitor extraction).
 * The Claude/Ollama-driven paths need a provider mock and land in P1.4 along
 * with the full agent integration suite.
 */

const EMPTY_VISITOR: VisitorContext = {
  industry: null,
  role: null,
  namedProblem: null,
  submittedUrl: null,
};

describe("heuristicIntent (fallback)", () => {
  it("classifies messages containing an external URL as problem-statement", () => {
    expect(heuristicIntent("can you audit https://example.com please")).toBe(
      "problem-statement",
    );
  });

  it("classifies Gravitas's own URLs as gravitas-question (discussion, not audit)", () => {
    expect(heuristicIntent("https://thisisgravitas.com")).toBe(
      "gravitas-question",
    );
    expect(
      heuristicIntent("can you tell me more about https://thisisgravitas.com/work/adgm"),
    ).toBe("gravitas-question");
    expect(heuristicIntent("any case studies on thisisgravitas.com?")).toBe(
      "gravitas-question",
    );
  });

  it("classifies messages mentioning Gravitas as gravitas-question (when no URL)", () => {
    expect(heuristicIntent("what does gravitas do?")).toBe("gravitas-question");
    expect(heuristicIntent("tell me about gravitas services")).toBe(
      "gravitas-question",
    );
  });

  it("classifies meta questions about the bot", () => {
    expect(heuristicIntent("are you an ai?")).toBe("meta-question");
    expect(heuristicIntent("how does this work")).toBe("meta-question");
    expect(heuristicIntent("is this a chatbot")).toBe("meta-question");
  });

  it("classifies short greetings as off-topic", () => {
    expect(heuristicIntent("hi")).toBe("off-topic");
    expect(heuristicIntent("hello there")).toBe("off-topic");
    expect(heuristicIntent("test")).toBe("off-topic");
  });

  it("defaults substantive messages to problem-statement", () => {
    expect(
      heuristicIntent("our mobile checkout has a 50% drop-off on the third step"),
    ).toBe("problem-statement");
  });
});

describe("extractVisitorPatchHeuristic", () => {
  it("captures the URL when the visitor explicitly asks to audit", () => {
    const patch = extractVisitorPatchHeuristic(
      "audit https://example.com/about please",
      EMPTY_VISITOR,
    );
    expect(patch.submittedUrl).toBe("https://example.com/about");
  });

  it("captures the URL when the message is essentially just the URL", () => {
    const patch = extractVisitorPatchHeuristic(
      "https://example.com",
      EMPTY_VISITOR,
    );
    expect(patch.submittedUrl).toBe("https://example.com/");
  });

  it("does NOT auto-audit when the visitor wants to discuss a URL", () => {
    // No audit keywords + meaningful surrounding text = discussion intent.
    // The graph should let Discovery respond rather than burn a 60s crawl.
    const patch = extractVisitorPatchHeuristic(
      "can you tell me more about https://example.com",
      EMPTY_VISITOR,
    );
    expect(patch.submittedUrl).toBeUndefined();
  });

  it("does NOT auto-audit Gravitas's own URLs", () => {
    // Gravitas pages go through KB-grounded discussion, never the audit path.
    const patch = extractVisitorPatchHeuristic(
      "audit https://thisisgravitas.com/work/adgm-platform-migration",
      EMPTY_VISITOR,
    );
    expect(patch.submittedUrl).toBeUndefined();
  });

  it("replaces an existing URL when the new URL differs and audit intent is clear", () => {
    const patch = extractVisitorPatchHeuristic(
      "now audit https://second.test/page",
      { ...EMPTY_VISITOR, submittedUrl: "https://first.test/" },
    );
    expect(patch.submittedUrl).toBe("https://second.test/page");
  });

  it("does not replace the existing URL when the message has no audit intent", () => {
    const patch = extractVisitorPatchHeuristic(
      "what about https://second.test/page — interesting?",
      { ...EMPTY_VISITOR, submittedUrl: "https://first.test/" },
    );
    expect(patch.submittedUrl).toBeUndefined();
  });

  it("captures a verbatim namedProblem from substantive messages", () => {
    const msg = "Our mobile checkout drops 50% of users on step three.";
    const patch = extractVisitorPatchHeuristic(msg, EMPTY_VISITOR);
    expect(patch.namedProblem).toBe(msg);
  });

  it("skips capturing namedProblem when message is too short", () => {
    const patch = extractVisitorPatchHeuristic("ok", EMPTY_VISITOR);
    expect(patch.namedProblem).toBeUndefined();
  });

  it("skips capturing namedProblem when already present", () => {
    const patch = extractVisitorPatchHeuristic(
      "we have a checkout problem on mobile sites",
      { ...EMPTY_VISITOR, namedProblem: "previous problem" },
    );
    expect(patch.namedProblem).toBeUndefined();
  });

  it("ignores non-parseable URL-looking strings", () => {
    const patch = extractVisitorPatchHeuristic(
      "we have htttp://broken... I think",
      EMPTY_VISITOR,
    );
    expect(patch.submittedUrl).toBeUndefined();
  });
});
