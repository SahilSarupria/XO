# Module 1 ships a build/test image only — there is no runtime service to
# containerize for production yet (no compiler/runtime/registry). This
# Dockerfile is the environment every future module's own Dockerfile will
# FROM off of, so its Node version and global tooling are the platform's
# single source of truth (see docs/adr/0002-language-and-runtime.md).

FROM node:20-bookworm-slim AS base
WORKDIR /workspace
RUN corepack enable

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
RUN npm install

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
RUN npm run build

FROM deps AS test
COPY tsconfig.base.json tsconfig.json ./
CMD ["npm", "test"]
