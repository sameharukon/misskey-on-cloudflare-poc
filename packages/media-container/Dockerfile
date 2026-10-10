# Media processing container for misskey-cf (sharp + ffmpeg), run by the
# misskey-cf-media Worker as the Cloudflare Container class `MediaContainer`.
#
# The image actually deployed is built WITHOUT Docker by scripts/push-image.mjs
# (esbuild bundle + crane append onto node:22-bookworm-slim). This Dockerfile
# produces the same layout (/app/dist/server.mjs, /app/node_modules, ffmpeg) for
# local builds:  docker build -t misskey-cf-media:local packages/media-container
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json ./
RUN npm install --no-audit --no-fund esbuild@0.24 sharp blurhash @misskey-dev/sharp-read-bmp@1.3.1
COPY src ./src
RUN npx esbuild src/server.ts --bundle --platform=node --target=node22 --format=esm \
      --outfile=dist/server.mjs --external:sharp --external:blurhash

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /src/dist ./dist
ENV NODE_ENV=production PORT=8080 FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 8080
ENTRYPOINT ["node"]
CMD ["dist/server.mjs"]
