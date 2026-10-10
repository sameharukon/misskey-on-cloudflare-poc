# stream (`misskey-cf-stream`)

Streaming (WebSocket) for upstream's protocol.

- **`StreamHub`**: one Durable Object per user holding that user's sockets (hibernatable WebSockets). Channel subscriptions and timeline options (`withRenotes` / `withFiles` / `withReplies`) are kept per socket; published events are filtered per subscription like upstream's channels.
- **`StreamPresence`**: shards (`STREAM_SHARD_COUNT`, default 16) recording which users are online on which channels, so the fanout reaches only connected users.
- **`NoteWatch`**: shards of note subscriptions (`subNote`) for `noteUpdated` events.
- Channel messages the hub cannot handle (Reversi) go to the api Worker over RPC.

The socket is authenticated by the api Worker before it reaches the hub.
