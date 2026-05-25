// No-op shim for the `server-only` module under Vitest.
// In production, `import "server-only"` throws at build time if a Client
// Component bundles a module that imports it. Tests don't do that check.
export {};
