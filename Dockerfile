# ── Stage 1: Build the agent ──
FROM node:22-slim AS agent-build

WORKDIR /agent
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./

ENV CI=true

# Install all deps (including devDependencies for tsc)
RUN npm ci

# Compile TypeScript to JavaScript
COPY src/ src/
RUN npm run build

# ── Stage 2: Production dependencies only ──
FROM node:22-slim AS agent-deps

WORKDIR /agent
COPY package.json package-lock.json ./

ENV CI=true

# Production deps only — no tsx, no typescript, no esbuild
RUN npm ci --omit=dev

# ── Stage 3: Runtime ──
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent

# Compiled JS from Stage 1, production node_modules from Stage 2
COPY --from=agent-build /agent/dist dist/
COPY --from=agent-deps /agent/node_modules node_modules/
COPY package.json ./

# Rule modules — copied into build context by build.sh
COPY rules/ rules/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV WORKSPACE_PATH=/workspace
ENV RULES_PATH=/agent/rules
ENV TERMINAL_MODE=local
ENV CI=true

ENTRYPOINT ["/entrypoint.sh"]
