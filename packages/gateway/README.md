# gateway (`misskey-cf-gateway`)

The only public Worker, on the instance's custom domain.

- Serves the upstream web client and embed client from static assets (`public/`, fetched from R2 at deploy time, see the root README).
- Generates the HTML shell like upstream's `ClientServerService`: initial data, OGP and per-page rendering for users, notes, pages, clips and so on, plus feeds and `/url`, `/twemoji-badge`, `/robots.txt`.
- Forwards `/api`, `/streaming`, ActivityPub, well-known routes, `/files`, `/proxy` and the like to the api Worker through the `API` service binding.
- Keeps anonymous HTML and media responses in the edge cache.
