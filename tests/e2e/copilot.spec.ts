import { test, expect } from "@playwright/test";

/**
 * Phase 0 smoke e2e — the wire test.
 *
 * Verifies (docs/ROADMAP.md → Phase 0 DoD):
 *   - /copilot renders the dual-pane shell (chat left, canvas right)
 *   - Typing "debug" and sending fires a DebugAction UIAction into the canvas
 *
 * The chat endpoint gracefully degrades to a streamed echo when no model
 * provider is configured, which is the expected CI condition. The DebugAction
 * is emitted unconditionally on the "debug" keyword, so the test is
 * deterministic regardless of provider availability.
 */

test.describe("/copilot Phase 0 wire", () => {
  test("renders the dual-pane shell", async ({ page }) => {
    await page.goto("/copilot");

    // Chat composer is present
    const composer = page.getByPlaceholder(
      /Describe a digital problem, or try the word `debug`/i,
    );
    await expect(composer).toBeVisible();

    // Canvas pane header is present (with the action count of "0 actions")
    await expect(page.getByText(/Canvas · 0 actions/i)).toBeVisible();

    // Canvas empty-state copy
    await expect(page.getByText(/The canvas is quiet — for now\./i)).toBeVisible();
  });

  test("sending `debug` produces a DebugAction in the canvas", async ({ page }) => {
    await page.goto("/copilot");

    const composer = page.getByPlaceholder(
      /Describe a digital problem, or try the word `debug`/i,
    );
    await composer.fill("debug please");
    await composer.press("Enter");

    // DebugAction header carries this exact label. Wait up to 60s — the
    // chat route's first-request compile is substantially slower in dev now
    // that it imports the full agent graph (LangGraph + every node + Chroma
    // client + Supabase). Once compiled, the DebugAction emission itself is
    // sub-second. Production builds compile ahead of time; this slack is a
    // dev-only tax.
    await expect(
      page.getByText(/Debug · DebugAction · v1/i),
    ).toBeVisible({ timeout: 60_000 });

    // The action count should have incremented from 0 → 1. By this point
    // the route is warm, so the default 5s is plenty.
    await expect(page.getByText(/Canvas · 1 action/i)).toBeVisible({ timeout: 10_000 });
  });
});
