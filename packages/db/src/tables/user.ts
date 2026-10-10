/** Inventory of `user` table key columns (upstream MiUser). */

export interface UserRow {
  id: string;
  updatedAt: Date | null;
  lastFetchedAt: Date | null;
  lastActiveDate: Date | null;
  hideOnlineStatus: boolean;
  username: string;
  usernameLower: string;
  name: string | null;
  followersCount: number;
  followingCount: number;
  notesCount: number;
  avatarId: string | null;
  bannerId: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  avatarBlurhash: string | null;
  bannerBlurhash: string | null;
  avatarDecorations: unknown;
  tags: string[];
  isBot: boolean;
  isCat: boolean;
  isLocked: boolean;
  isSilenced: boolean;
  isSuspended: boolean;
  isDeleted: boolean;
  host: string | null;
  inbox: string | null;
  sharedInbox: string | null;
  featured: string | null;
  uri: string | null;
  followersUri: string | null;
  token: string | null;
}
