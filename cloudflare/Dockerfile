FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY engine/package.json ./engine/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY player-runtime/package.json ./player-runtime/package.json
COPY mobile/package.json ./mobile/package.json
RUN npm ci --ignore-scripts --workspace @aside/backend --workspace @aside/engine --include-workspace-root
COPY engine ./engine
COPY backend ./backend
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "backend/src/container/index.ts"]
