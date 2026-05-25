import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest config.
 *
 * Phase 0 scope:
 *   - Schema validation tests (UIAction, AuditResult)
 *   - Stream emitter tests (emitUIAction validation gate)
 *   - Router decision tests (cap-hit / no-key paths that throw synchronously)
 *   - Pricing math tests
 *
 * Component tests (@testing-library/react) and worker integration tests come
 * in Phase 1 — they need additional deps and a real DOM environment.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@/app": resolve(__dirname, "app"),
      // `server-only` is a Next.js build-time sentinel that throws if a client
      // bundle imports it. Vitest doesn't run that check; map to a no-op so
      // tests can import modules that mark themselves server-only.
      "server-only": resolve(__dirname, "tests/__mocks__/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Worker tests live in worker/ and run via the worker's own typecheck/test
    // (Phase 1+). Don't pull them into the root run.
    exclude: ["worker/**", "tests/e2e/**", "node_modules/**", "dist/**", ".next/**"],
    globals: false,
    reporters: process.env.CI ? ["default", "junit"] : "default",
    outputFile: process.env.CI ? { junit: "./test-results/junit.xml" } : undefined,
  },
});
