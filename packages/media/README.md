# media (`misskey-cf-media`)

Fronts the [media-container](../media-container) (sharp + ffmpeg) for the api and gateway Workers; not public.

- `POST /alts` (upload thumbnails / webpublic / blurhash) goes to the `media-bulk` instance.
- `POST /proxy` and `/twemoji-badge` are spread over `media-0`..`media-2` by the hash of the source URL (`src/instance.ts`).
- Instances sleep after 5 minutes without requests; `max_instances` in `wrangler.toml` covers the proxy instances, the bulk instance and one for rollouts.
