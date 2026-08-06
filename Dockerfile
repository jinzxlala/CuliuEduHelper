FROM node:22.23.2-bookworm-slim AS workspace

ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/knowledge-web/package.json ./apps/knowledge-web/package.json
COPY apps/operations-web/package.json ./apps/operations-web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/authorization/package.json ./packages/authorization/package.json
COPY packages/course-planning/package.json ./packages/course-planning/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/knowledge-analysis/package.json ./packages/knowledge-analysis/package.json
COPY packages/knowledge-ingest/package.json ./packages/knowledge-ingest/package.json
COPY packages/operations/package.json ./packages/operations/package.json
COPY packages/search/package.json ./packages/search/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/student-ingest/package.json ./packages/student-ingest/package.json
COPY packages/student-profiles/package.json ./packages/student-profiles/package.json
COPY packages/student-records/package.json ./packages/student-records/package.json
COPY packages/tasks/package.json ./packages/tasks/package.json

RUN --mount=type=cache,id=culiu-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && \
    pnpm config set fetch-retries 5 && \
    pnpm config set fetch-retry-mintimeout 10000 && \
    pnpm config set fetch-retry-maxtimeout 120000 && \
    pnpm config set fetch-timeout 300000 && \
    pnpm config set network-concurrency 4 && \
    pnpm install --frozen-lockfile

COPY .prettierignore .prettierrc.json eslint.config.mjs ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
COPY knowledge ./knowledge

FROM workspace AS build

RUN pnpm build

FROM build AS deployment-assets

RUN pnpm --filter @culiu/worker deploy --prod --legacy /out/worker
RUN pnpm --filter @culiu/authorization deploy --prod --legacy /out/authorization
RUN pnpm --filter @culiu/knowledge-web deploy --prod --legacy /out/knowledge-web
RUN pnpm --filter @culiu/operations-web deploy --prod --legacy /out/operations-web

FROM node:22.23.2-bookworm-slim AS knowledge-web

ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/knowledge-web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/knowledge-web/.next/static ./apps/knowledge-web/.next/static
COPY --from=deployment-assets --chown=node:node /out/knowledge-web/node_modules ./node_modules

USER node
EXPOSE 3000
CMD ["node", "apps/knowledge-web/server.js"]

FROM node:22.23.2-bookworm-slim AS operations-web

ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/operations-web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/operations-web/.next/static ./apps/operations-web/.next/static
COPY --from=deployment-assets --chown=node:node /out/operations-web/node_modules ./node_modules

USER node
EXPOSE 3000
CMD ["node", "apps/operations-web/server.js"]

FROM node:22.23.2-bookworm-slim AS worker

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deployment-assets --chown=node:node /out/worker ./
COPY --from=build --chown=node:node /app/knowledge/source-manifest.v1.json ./knowledge/source-manifest.v1.json

USER node
CMD ["node", "dist/index.js"]

FROM node:22.23.2-bookworm-slim AS admin

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deployment-assets --chown=node:node /out/authorization ./

USER node
ENTRYPOINT ["node", "dist/cli/create-initial-admin.js"]
