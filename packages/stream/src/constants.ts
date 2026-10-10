/**
 * Kept out of index.ts: a Worker's entry module may only export handlers and classes (workerd
 * refuses to start on an exported number).
 */

/** upstream StreamingApiServerService: lastActiveDate refresh interval while a socket is open. */
export const LAST_ACTIVE_REFRESH_MS = 1000 * 60 * 5;

/**
 * StreamPresence / NoteWatch drop entries a day old (they clean up after hubs that ended without
 * webSocketClose). A hub with open sockets registers its user again this often, so a socket left
 * open for days keeps receiving timelines, broadcasts and noteUpdated, as upstream connections do.
 */
export const PRESENCE_RESYNC_MS = 12 * 3600_000;
