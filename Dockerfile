# syntax=docker/dockerfile:1.7
FROM node:24.14.0-alpine AS build

ARG SERVICE=api
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY services ./services

RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@zuocheng/${SERVICE}..." build
RUN pnpm --filter "@zuocheng/${SERVICE}" deploy --prod /production

FROM node:24.14.0-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /production ./
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]

