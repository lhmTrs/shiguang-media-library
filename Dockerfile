FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production MEDIA_DATA_DIR=/data MEDIA_SKIP_IMPORT=1 MEDIA_CONTAINER=1 MEDIA_READONLY_FILES=1 PORT=4317
USER node
VOLUME /data
EXPOSE 4317
CMD ["node", "server/index.mjs"]
