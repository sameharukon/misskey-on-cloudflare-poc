/** Supporting tables for Tier A graph / drive / auth. */

export interface UserProfileRow {
  userId: string;
  description: string | null;
  location: string | null;
  birthday: string | null;
  lang: string | null;
  fields: { name: string; value: string }[];
  email: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  followersVisibility: string;
  followingVisibility: string;
}

export interface FollowingRow {
  id: string;
  createdAt: Date;
  followeeId: string;
  followerId: string;
  followerHost: string | null;
  followeeHost: string | null;
}

export interface BlockingRow {
  id: string;
  createdAt: Date;
  blockerId: string;
  blockeeId: string;
}

export interface MutingRow {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
  muterId: string;
  muteeId: string;
}

export interface DriveFileRow {
  id: string;
  userId: string | null;
  userHost: string | null;
  md5: string;
  name: string;
  type: string;
  size: number;
  comment: string | null;
  blurhash: string | null;
  properties: Record<string, unknown>;
  storedInternal: boolean;
  url: string;
  thumbnailUrl: string | null;
  webpublicUrl: string | null;
  accessKey: string | null;
  thumbnailAccessKey: string | null;
  webpublicAccessKey: string | null;
  uri: string | null;
  isSensitive: boolean;
  folderId: string | null;
}

export interface NotificationRow {
  id: string;
  createdAt: Date;
  notifieeId: string;
  notifierId: string | null;
  type: string;
  isRead: boolean;
  noteId: string | null;
  reaction: string | null;
}

export interface EmojiRow {
  id: string;
  updatedAt: Date | null;
  name: string;
  host: string | null;
  originalUrl: string;
  publicUrl: string;
  uri: string | null;
  type: string | null;
  aliases: string[];
  category: string | null;
  license: string | null;
  isSensitive: boolean;
  localOnly: boolean;
}

export interface AccessTokenRow {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  userId: string;
  token: string;
  hash: string;
  name: string | null;
  description: string | null;
  permission: string[];
  appId: string | null;
}
