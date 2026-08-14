# Veltr Agent — container image.
#
# Built for a host that keeps a process alive and gives it a disk. That is not a
# preference: the scheduler is an in-process loop (Telegram long-poll, the
# corporate-action watcher, the token monitor, the change tracker), and the state
# it depends on is a file. Serverless gives neither, which is why this is a
# container rather than a set of functions.
#
# Multi-stage so the runtime image carries no build toolchain and no dev
# dependencies.

# ---------------------------------------------------------------- deps
FROM node:24-slim AS deps
WORKDIR /app

# Copied alone so this layer is reused whenever only source changed.
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build
FROM node:24-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next reads NODE_ENV at build time; the production build is the only one this
# image should ever produce.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ------------------------------------------------------------- runtime
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# State lives on a mounted volume, not in the image. Without this the subscriber
# list, every watchlist, every mission and the Telegram cursor are wiped on each
# redeploy — and a reset cursor reprocesses old messages.
ENV VELTR_DATA_DIR=/data

RUN npm i -g npm@latest > /dev/null 2>&1 || true

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

# Owned by the unprivileged user Node's image already provides, so the volume is
# writable without running as root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

# The platform's health check should target this. It reports "degraded" and 503
# when the state directory is not writable, which is the failure worth catching
# before it silently eats a deploy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
