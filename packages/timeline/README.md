# timeline (`misskey-cf-timeline`)

Delivers new notes and keeps per-user notification storage.

- **Fanout consumer** (`mk-timeline-fanout`): sends each note to the online users' streaming channels (home, hybrid, local, global, lists, antennas, roles, channels) through the stream Worker's presence shards, applying mutes, blocks and visibility. The author's own timelines are sent by the api Worker directly.
- **`TimelineShard`**: antenna and role timelines (Durable Object SQLite).
- **`NotificationBox`**: each user's notifications and read position.
- **`OpsStats`**: queue counters and the failed / delayed job records shown in the admin queue UI.
