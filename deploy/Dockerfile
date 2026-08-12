# LeadFlow API + built client, in one image.
#
# The client is built here and SERVED BY NGINX ON THE HOST, not from this
# image — the host already terminates TLS for cloud.projexlight.com and adding a
# second web server inside the container would mean two places to configure the
# same vhost. The build output is copied out by deploy.sh.

FROM node:20-alpine AS build
WORKDIR /src

# Manifests first so a dependency install is cached across code-only changes.
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm ci --prefix server && npm ci --prefix client

COPY . .
RUN npm --prefix server run build && npm --prefix client run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. The build stage's devDependencies are the
# larger half of node_modules and none of it runs in production.
COPY server/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /src/server/dist ./dist
# The migrations ship with the image. The runner resolves them beside the
# compiled module first, and a `dist` build that skipped this copy would boot
# and silently apply NOTHING — which is precisely the drift the runner was
# hardened against.
COPY --from=build /src/server/src/db/migrations ./dist/db/migrations

# The client bundle rides along so deploy.sh can extract it to the nginx root
# without a second build.
COPY --from=build /src/client/dist ./client-dist

# Unprivileged. The image needs no write access to its own filesystem.
USER node

EXPOSE 3010
# dist/app.js, not dist/index.js. server/package.json declares both `main` and
# `start` as dist/app.js and src/ has no index.ts at all, so the old CMD gave a
# container that built cleanly and then crash-looped on MODULE_NOT_FOUND.
CMD ["node", "dist/app.js"]
