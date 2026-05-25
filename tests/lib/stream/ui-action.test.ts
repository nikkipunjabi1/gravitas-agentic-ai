import { describe, it, expect, vi } from "vitest";
import { emitUIAction } from "@/lib/stream/ui-action";
import type { DataStreamWriter, JSONValue } from "@/lib/stream/data-stream";
import type { UIAction } from "@/canvas/schema";

/**
 * emitUIAction is the chokepoint that validates UIActions before they hit the
 * wire. These tests pin two behaviours:
 *
 *   1. Valid actions are written through to writeData unchanged.
 *   2. Invalid actions are dropped — writer.writeData is NOT called.
 */
describe("emitUIAction", () => {
  function fakeWriter() {
    const writes: JSONValue[] = [];
    const writer: DataStreamWriter = {
      writeText: vi.fn(),
      writeData: vi.fn((v: JSONValue) => writes.push(v)),
      finish: vi.fn(),
      error: vi.fn(),
      close: vi.fn(),
    };
    return { writer, writes };
  }

  it("writes a validated DebugAction as a ui-action data part", () => {
    const { writer, writes } = fakeWriter();
    const action: UIAction = {
      type: "DebugAction",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: { hi: "there" },
    };
    emitUIAction(writer, action, { sessionId: "22222222-2222-4222-8222-222222222222", node: "test" });
    expect(writer.writeData).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    const part = writes[0] as { type: string; action: UIAction };
    expect(part.type).toBe("ui-action");
    expect(part.action.type).toBe("DebugAction");
    expect(part.action.id).toBe(action.id);
  });

  it("drops an invalid action and does not call writeData", () => {
    const { writer } = fakeWriter();
    // Bogus discriminator → schema fails → drop.
    const bogus = {
      type: "TotallyMadeUp",
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      data: {},
    } as unknown as UIAction;

    // Silence the expected error log so the test output isn't noisy.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitUIAction(writer, bogus);
    expect(writer.writeData).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("drops a malformed AuditFindings (title too long) and does not call writeData", () => {
    const { writer } = fakeWriter();
    const bad: UIAction = {
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
            title: "x".repeat(120), // > 80 cap
            detail: "ok",
            gravitasService: null,
          },
        ],
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emitUIAction(writer, bad);
    expect(writer.writeData).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
