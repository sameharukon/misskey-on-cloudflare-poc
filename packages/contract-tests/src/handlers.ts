/**
 * Stand-in API handlers for TypeScript contract checks.
 * Return types must assign to misskey-js response aliases.
 */
import {
  packMetaDetailed,
  packMetaLite,
  packNote,
  packUserLite,
  type PackConfig,
  type PackMetaSource,
  type PackNoteSource,
  type PackUserSource,
} from "../../packers/src/index.js";
import type {
  IResponse,
  MeDetailed,
  MetaDetailed,
  MetaLite,
  MetaResponse,
  Note,
  NotesShowResponse,
  NotesTimelineResponse,
} from "../../misskey-js-types/src/index.js";

export interface HandlerDeps {
  config: PackConfig;
  meta: PackMetaSource;
  me: PackUserSource;
  notes: PackNoteSource[];
  usersById: Map<string, PackUserSource>;
}

/** POST /api/meta — detail=false → MetaLite; default/true → MetaDetailed */
export function handleMeta(
  deps: HandlerDeps,
  body?: { detail?: boolean },
): MetaResponse {
  if (body?.detail === false) {
    return packMetaLite(deps.meta, deps.config) satisfies MetaLite;
  }
  return packMetaDetailed(deps.meta, deps.config, {
    proxyAccountName: "proxy",
  }) satisfies MetaDetailed;
}

/**
 * Type check only: a MeDetailed put together from the packers with fixed unread / secret fields,
 * to confirm the shape assigns to misskey-js `IResponse`. Production `/api/i` is `packMe`
 * (packages/api/src/client-endpoints-pg.ts), which this does not exercise.
 */
export function meDetailedShape(deps: HandlerDeps): IResponse {
  const lite = packUserLite(deps.me, deps.config, deps.meta);
  const policies = packMetaDetailed(deps.meta, deps.config, {
    proxyAccountName: null,
  }).policies;

  const me = {
    ...lite,
    url: null,
    uri: null,
    movedTo: null,
    alsoKnownAs: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: null,
    lastFetchedAt: null,
    bannerUrl: null,
    bannerBlurhash: null,
    isLocked: false,
    isSilenced: false,
    isSuspended: false,
    description: null,
    location: null,
    birthday: null,
    lang: null,
    fields: [],
    verifiedLinks: [],
    followersCount: 0,
    followingCount: 0,
    notesCount: 0,
    pinnedNoteIds: [],
    pinnedNotes: [],
    pinnedPageId: null,
    pinnedPage: null,
    publicReactions: true,
    followingVisibility: "public" as const,
    followersVisibility: "public" as const,
    chatScope: "everyone" as const,
    canChat: true,
    roles: [],
    memo: null,
    avatarId: deps.me.avatarId,
    bannerId: null,
    followedMessage: null,
    isModerator: false,
    isAdmin: false,
    injectFeaturedNote: true,
    receiveAnnouncementEmail: true,
    alwaysMarkNsfw: false,
    autoSensitive: false,
    carefulBot: false,
    autoAcceptFollowed: false,
    noCrawle: false,
    preventAiLearning: true,
    isExplorable: true,
    isDeleted: false,
    twoFactorBackupCodesStock: "none" as const,
    hideOnlineStatus: false,
    hasUnreadSpecifiedNotes: false,
    hasUnreadMentions: false,
    hasUnreadChatMessages: false,
    hasUnreadAnnouncement: false,
    unreadAnnouncements: [],
    hasUnreadAntenna: false,
    hasUnreadChannel: false,
    hasUnreadNotification: false,
    hasPendingReceivedFollowRequest: false,
    unreadNotificationsCount: 0,
    mutedWords: [] as string[][],
    hardMutedWords: [] as string[][],
    mutedInstances: [] as string[],
    notificationRecieveConfig: {},
    emailNotificationTypes: [] as string[],
    achievements: [],
    loggedInDays: 0,
    policies,
    twoFactorEnabled: false,
    usePasswordLessLogin: false,
    securityKeys: false,
  } as MeDetailed;

  return me;
}

export function handleNotesShow(deps: HandlerDeps, noteId: string): NotesShowResponse {
  const note = deps.notes.find((n) => n.id === noteId);
  if (!note) throw new Error("NO_SUCH_NOTE");
  const author = deps.usersById.get(note.userId);
  if (!author) throw new Error("NO_SUCH_USER");
  return packNote(note, {
    user: packUserLite(author, deps.config, deps.meta),
  }) satisfies NotesShowResponse;
}

export function handleNotesTimeline(deps: HandlerDeps): NotesTimelineResponse {
  return deps.notes.map((note) => {
    const author = deps.usersById.get(note.userId);
    if (!author) throw new Error("NO_SUCH_USER");
    return packNote(note, {
      user: packUserLite(author, deps.config, deps.meta),
    });
  }) satisfies NotesTimelineResponse;
}

export function _typeAsserts(meta: MetaResponse, note: Note, me: IResponse): void {
  void meta;
  void note;
  void me;
}
