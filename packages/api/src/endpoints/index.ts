import type { ApiEnv } from "../env.js";
import * as ping from "./ping.js";
import * as meta from "./meta.js";
import * as emojis from "./emojis.js";
import * as emoji from "./emoji.js";
import * as endpoints from "./endpoints.js";
import * as endpoint from "./endpoint.js";
import * as i from "./i.js";
import * as adminMeta from "./admin/meta.js";
import * as adminUpdateMeta from "./admin/update-meta.js";
import * as adminServerInfo from "./admin/server-info.js";
import * as adminAccountsCreate from "./admin/accounts/create.js";
import * as iUpdate from "./i/update.js";
import * as adminCfDebugTimeline from "./admin/cf-debug/timeline.js";
import * as adminCfDebugQueues from "./admin/cf-debug/queues.js";
import * as adminCfDebugBackfillInstances from "./admin/cf-debug/backfill-instances.js";
import * as adminQueueStats from "./admin/queue/stats.js";
import * as signinFlow from "./signin-flow.js";

export type EndpointHandler = (
  env: ApiEnv,
  body: Record<string, unknown>,
  ctx: {
    hasCredential: boolean;
    request: Request;
    file?: import("../drive-pg.js").UploadedFile;
    waitUntil?: (p: Promise<unknown>) => void;
  },
) => Promise<Response | unknown>;

import { clientHandlers } from "../client-endpoints-pg.js";
import { driveHandlers } from "../drive-pg.js";
import { pollHandlers } from "../polls-pg.js";
import { clipHandlers } from "../clips-pg.js";
import { emojiAdminHandlers } from "../emojis-pg.js";
import { searchHandlers } from "../search-pg.js";
import { listHandlers } from "../lists-pg.js";
import { antennaHandlers } from "../antennas-pg.js";
import { channelHandlers } from "../channels-pg.js";
import { announcementAdminHandlers } from "../admin-announcements-pg.js";
import { roleHandlers } from "../roles-pg.js";
import { adminUserHandlers } from "../admin-users-pg.js";
import { abuseHandlers } from "../abuse-reports-pg.js";
import { inviteHandlers } from "../invites-pg.js";
import { accountHandlers } from "../account-pg.js";
import { passkeyHandlers } from "../passkey-pg.js";
import { webhookHandlers } from "../webhooks-pg.js";
import { deleteAccountHandlers } from "../account-delete-pg.js";
import { exportHandlers } from "../exports-pg.js";
import { importHandlers } from "../imports-pg.js";
import { swHandlers } from "../sw-pg.js";
import { pageHandlers } from "../pages-pg.js";
import { galleryHandlers } from "../gallery-pg.js";
import { flashHandlers } from "../flash-pg.js";
import { chartHandlers } from "../charts-pg.js";
import { clientMiscHandlers } from "../client-misc-pg.js";
import { draftHandlers } from "../drafts-pg.js";
import { adHandlers } from "../ads-pg.js";
import { miscHandlers } from "../misc-pg.js";
import { systemWebhookHandlers } from "../system-webhooks-pg.js";
import { reversiHandlers } from "../reversi-pg.js";
import { bubbleGameHandlers } from "../bubble-game-pg.js";
import { federationHandlers } from "../federation-pg.js";
import { chatHandlers } from "../chat-pg.js";
import { adminMiscHandlers } from "../admin-misc-pg.js";
import { emojiIoHandlers } from "../emoji-io-pg.js";
import { adminQueueHandlers } from "../admin-queue-pg.js";
import { translateHandlers } from "../translate-pg.js";
import { accountMoveHandlers } from "../account-move-pg.js";
import { emailHandlers } from "../email-pg.js";
import { signupApiHandlers } from "../signup-api-pg.js";
import { pgOverrides, socialApiHandlers } from "../social-api-pg.js";
import { notesApiHandlers } from "../notes-api-pg.js";
import { appAuthApiHandlers } from "../app-auth-api-pg.js";
import { notesReadHandlers } from "../notes-read-pg.js";

export const handlers: Record<string, EndpointHandler> = {
  ...clientHandlers,
  ...driveHandlers,
  ...pollHandlers,
  ...clipHandlers,
  ...emojiAdminHandlers,
  ...searchHandlers,
  ...listHandlers,
  ...antennaHandlers,
  ...channelHandlers,
  ...announcementAdminHandlers,
  ...roleHandlers,
  ...adminUserHandlers,
  ...abuseHandlers,
  ...inviteHandlers,
  ...accountHandlers,
  ...passkeyHandlers,
  ...webhookHandlers,
  ...deleteAccountHandlers,
  ...accountMoveHandlers,
  ...exportHandlers,
  ...importHandlers,
  ...swHandlers,
  ...pageHandlers,
  ...galleryHandlers,
  ...flashHandlers,
  ...chartHandlers,
  ...clientMiscHandlers,
  ...draftHandlers,
  ...adHandlers,
  ...miscHandlers,
  ...systemWebhookHandlers,
  ...reversiHandlers,
  ...bubbleGameHandlers,
  ...federationHandlers,
  ...chatHandlers,
  ...adminMiscHandlers,
  ...emojiIoHandlers,
  ...adminQueueHandlers,
  ...translateHandlers,
  ...emailHandlers,
  ...signupApiHandlers,
  ...notesApiHandlers,
  ...appAuthApiHandlers,
  ...socialApiHandlers,
  ...pgOverrides({ "notes/show-partial-bulk": notesReadHandlers["notes/show-partial-bulk"]! }),
  [ping.name]: (env, body) => ping.handle(env, body),
  [meta.name]: (env, body) => meta.handle(env, body),
  [emojis.name]: (env, body) => emojis.handle(env, body),
  [emoji.name]: (env, body) => emoji.handle(env, body),
  [endpoints.name]: (env, body) => endpoints.handle(env, body),
  [endpoint.name]: (env, body) => endpoint.handle(env, body),
  [i.name]: (env, body, ctx) => i.handle(env, body, ctx),
  [adminMeta.name]: (env, body, ctx) => adminMeta.handle(env, body, ctx),
  [adminUpdateMeta.name]: (env, body, ctx) => adminUpdateMeta.handle(env, body, ctx),
  [adminServerInfo.name]: (env, body, ctx) => adminServerInfo.handle(env, body, ctx),
  [adminAccountsCreate.name]: (env, body, ctx) => adminAccountsCreate.handle(env, body, ctx),
  [signinFlow.name]: (env, body, ctx) => signinFlow.handle(env, body, ctx),
  [iUpdate.name]: (env, body, ctx) => iUpdate.handle(env, body, ctx),
  [adminCfDebugTimeline.name]: (env, body, ctx) => adminCfDebugTimeline.handle(env, body, ctx),
  [adminCfDebugQueues.name]: (env, body, ctx) => adminCfDebugQueues.handle(env, body, ctx),
  [adminQueueStats.name]: (env, body, ctx) => adminQueueStats.handle(env, body, ctx),
  [adminCfDebugBackfillInstances.name]: (env, body, ctx) => adminCfDebugBackfillInstances.handle(env, body, ctx),
};
