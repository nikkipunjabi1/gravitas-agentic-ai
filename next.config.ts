import type { NextConfig } from "next";

/**
 * Allow-list of origins permitted to iframe /copilot.
 *
 * `'self'` keeps the page reachable on its own domain. The two thisisgravitas
 * entries allow the embeddable widget (public/embed.js) to mount inside the
 * marketing site. Adjust here when more partner sites need to embed.
 *
 * Override via `NEXT_PUBLIC_EMBED_ALLOWED_ORIGINS` (space-separated, same
 * format as the CSP value) without editing this file.
 */
const EMBED_FRAME_ANCESTORS =
  process.env.NEXT_PUBLIC_EMBED_ALLOWED_ORIGINS ??
  "'self' https://thisisgravitas.com https://*.thisisgravitas.com";

const config: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server Actions are stable in Next 15; nothing experimental needed yet.
  },
  // Keep the canvas/chat panes responsive. Compress responses by default.
  compress: true,
  // The crawl worker is a separate service; do not bundle Playwright into Next.
  serverExternalPackages: ["@anthropic-ai/sdk"],

  /**
   * Frame-ancestors CSP for the embedded /copilot route.
   *
   * Default Next.js sends `X-Frame-Options: SAMEORIGIN` site-wide, which
   * blocks the iframe even when CSP frame-ancestors would allow it (older
   * browsers honour X-Frame-Options first). We override BOTH on /copilot:
   *
   *   - Remove X-Frame-Options (set to empty so the framework's default
   *     doesn't apply — frame-ancestors handles it on modern browsers).
   *   - Set Content-Security-Policy: frame-ancestors with the allow-list.
   *
   * embed.js itself is served from /embed.js — no framing concerns there,
   * but we add a long cache header to make repeat page loads cheap.
   */
  async headers() {
    return [
      {
        source: "/copilot",
        headers: [
          { key: "X-Frame-Options", value: "" },
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${EMBED_FRAME_ANCESTORS}`,
          },
        ],
      },
      {
        source: "/embed.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default config;
