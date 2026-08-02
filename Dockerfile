FROM node:22.23.2-bookworm-slim AS workspace

ENV CI=true
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY .prettierignore .prettierrc.json eslint.config.mjs ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
COPY knowledge ./knowledge

RUN --mount=type=cache,id=culiu-pnpm,target=/root/.cache/pnpm \
    pnpm install --frozen-lockfile

FROM workspace AS build

RUN pnpm build

FROM build AS deployment-assets

RUN pnpm --filter @culiu/worker deploy --prod --legacy /out/worker
RUN pnpm --filter @culiu/authorization deploy --prod --legacy /out/authorization

FROM node:22.23.2-bookworm-slim AS web

ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

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
