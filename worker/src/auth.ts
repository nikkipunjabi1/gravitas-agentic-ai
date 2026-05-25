import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Shared-secret guard for the crawl worker.
 *
 * Every inbound request must carry `Authorization: Bearer <secret>` where
 * `secret` matches `CRAWL_WORKER_SHARED_SECRET`. This is intentionally low-tech:
 *
 *   - The worker is on a private network in production (Railway), so the
 *     secret is the second line of defence, not the first.
 *   - A constant-time compare avoids accidental timing leaks.
 *   - The Next.js app is the only legitimate caller, so a missing/wrong
 *     secret is a 401 with no further detail.
 *
 * /health is intentionally still guarded — admin polls it with the secret
 * (docs/ADMIN_PANEL.md → Health table). If Railway needs an unauthenticated
 * liveness probe, expose a separate `/live` endpoint at deploy time.
 */
export function authPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const expected = process.env.CRAWL_WORKER_SHARED_SECRET;
  if (!expected || expected.length < 16) {
    // Mis-configuration: fail closed loudly. This is preferable to silently
    // accepting requests in a misconfigured environment.
    req.log.error(
      "CRAWL_WORKER_SHARED_SECRET is not set or is suspiciously short — refusing all requests",
    );
    reply.code(500).send({
      error: "worker_misconfigured",
      detail: "CRAWL_WORKER_SHARED_SECRET not set",
    });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  const provided = header.slice("Bearer ".length).trim();
  if (!constantTimeEqual(provided, expected)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  done();
}

/**
 * Length-aware constant-time string compare. Returns false fast on length
 * mismatch (a known timing leak, but the alternative — padding — leaks the
 * expected length, which is worse). For HMAC-style secrets where length is
 * fixed by configuration, this is the right trade-off.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
