# All dependencies are pure JavaScript, so the slim image needs no toolchain.
# bookworm-slim rather than alpine to match ReviewNudge's base.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies from the tree that gets copied into the runtime image.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    GJB_CONFIG=/app/config/config.yaml \
    GJB_HOST=0.0.0.0 \
    GJB_PORT=8090

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# /app/data holds state.json (dedup memory) and audit.jsonl; both must outlive
# the container. The default ./data/... paths in config resolve here.
RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node
VOLUME ["/app/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GJB_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `docker compose exec bridge node dist/cli.js audit --key ABC-123` reads the trail.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
