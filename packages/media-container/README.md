# media-container

The Container image run by the media Worker: Node.js with sharp and ffmpeg, no internet access.

| Route | Purpose |
|---|---|
| `POST /alts?type=&web=` | Thumbnail, webpublic and blurhash for an uploaded file (images and videos) |
| `POST /proxy?mode=&mime=&static=` | Media proxy conversions (emoji, avatar, static, preview, badge, SVG) |
| `POST /twemoji-badge` | Twemoji SVG → monochrome notification badge PNG |

`pnpm build:image` builds it locally with Docker; `pnpm push:image` builds and pushes to the Cloudflare registry without Docker (`scripts/push-image.mjs`). Bump the image tag in `packages/media/wrangler.toml` to deploy a new image.
