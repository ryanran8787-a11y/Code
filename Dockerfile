# CursorWeb — Node service (needs a real fs + shell + git, so it cannot run
# on Workers/Pages-style runtimes). Linux image: bash, git worktrees and
# /proc port detection all work out of the box.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    WORKSPACE=/workspace
VOLUME /workspace
EXPOSE 3000

CMD ["npm", "start"]
