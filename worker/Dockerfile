# Gravitas crawl worker — production container.
#
# Phase 0 ships the scaffold image. Phase 1 will add Playwright system
# dependencies (Chromium + the long list of shared libs Lighthouse needs);
# see the marker block near the end of this file for what to add then.
#
# Build:    docker build -t gravitas-worker -f worker/Dockerfile .
# Run:      docker run -p 8787:8787 --env-file .env.local gravitas-worker
#
# On Railway this Dockerfile is used directly (Path C in ARCHITECTURE.md).

# -- Build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# pnpm via corepack — keeps the worker's lockfile honoured.
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# Copy only the worker package — production builds don't need the Next.js app.
COPY worker/package.json worker/tsconfig.json ./worker/
COPY pnpm-workspace.yaml package.json ./

RUN pnpm install --filter @gravitas/worker --frozen-lockfile=false

COPY worker/src ./worker/src
RUN pnpm --filter @gravitas/worker build

# -- Runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WORKER_PORT=8787
ENV WORKER_HOST=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ---- Playwright Chromium system dependencies ----------------------------
# Canonical list from `playwright install --with-deps chromium` on Debian
# bookworm. We pin them here so the image build is deterministic and doesn't
# require network access to the Playwright apt-deps list at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-noto-color-emoji \
      libasound2 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      wget \
      xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

COPY --from=build /app/worker/package.json ./worker/package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/worker/dist ./worker/dist
COPY --from=build /app/node_modules ./node_modules

# Install the Chromium browser binary into the shared $PLAYWRIGHT_BROWSERS_PATH.
# Run AFTER node_modules so playwright can find itself.
RUN cd /app && pnpm --filter @gravitas/worker exec playwright install chromium

EXPOSE 8787

# Liveness — Railway pings this. Authorization header is required; if your
# liveness probe can't send headers, deploy an unauthenticated /live endpoint
# behind a Phase 1 feature flag.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health',{headers:{authorization:'Bearer '+process.env.CRAWL_WORKER_SHARED_SECRET}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "worker/dist/index.js"]
