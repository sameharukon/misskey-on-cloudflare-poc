/**
 * `mk-jobs` messages and their dispatcher (consumed by this worker, one message per batch).
 * A step returns its follow-up message (re-enqueued by the consumer) or null when done.
 */

import type { ApiEnv } from "./env.js";
import { runDeleteAccountStep, type DeleteAccountJob } from "./account-delete-pg.js";
import { runExport, type ExportJob } from "./exports-pg.js";
import { runImport, type ImportJob } from "./imports-pg.js";
import { runPushJob, type PushJob } from "./sw-pg.js";
import { runPostScheduledNote, type PostScheduledNoteJob } from "./drafts-pg.js";
import { runChatNotifyJob, type ChatNotifyJob } from "./chat-pg.js";
import { runDriveCleanupStep, type DriveCleanupJob } from "./admin-misc-pg.js";

import { runBackfillInstancesStep, type BackfillInstancesJob } from "./maintenance-pg.js";
import { runSendEmailJob, type SendEmailJob } from "./email.js";
import { runExportCustomEmojis, runImportCustomEmojis, type ExportCustomEmojisJob, type ImportCustomEmojisJob } from "./emoji-io-pg.js";
import { runAccountMoveStep, type AccountMoveJob } from "./account-move-pg.js";
import { runRemoteFileJob, type RemoteFileJob } from "./ap/remote-file.js";
import { runUpdateFeaturedJob, type UpdateFeaturedJob } from "./ap/featured.js";
import { runDriveAltsJob, type DriveAltsJob } from "./drive-pg.js";
import { runCleanRemoteNotesStep, type CleanRemoteNotesJob } from "./clean-remote-notes-pg.js";

export type JobMessage = DeleteAccountJob | ExportJob | ImportJob | PushJob | PostScheduledNoteJob | ChatNotifyJob | DriveCleanupJob | ExportCustomEmojisJob | ImportCustomEmojisJob | BackfillInstancesJob | AccountMoveJob | SendEmailJob | RemoteFileJob | DriveAltsJob | UpdateFeaturedJob | CleanRemoteNotesJob;

export async function runJobStep(env: ApiEnv, job: JobMessage): Promise<JobMessage | null> {
  switch (job.kind) {
    case "deleteAccount":
      return runDeleteAccountStep(env, job);
    case "export":
      await runExport(env, job);
      return null;
    case "import":
      await runImport(env, job);
      return null;
    case "push":
      await runPushJob(env, job);
      return null;
    case "postScheduledNote":
      await runPostScheduledNote(env, job);
      return null;
    case "chatNotify":
      await runChatNotifyJob(env, job);
      return null;
    case "driveCleanup":
      return runDriveCleanupStep(env, job);
    case "exportCustomEmojis":
      await runExportCustomEmojis(env, job);
      return null;
    case "sendEmail":
      await runSendEmailJob(env, job);
      return null;
    case "importCustomEmojis":
      return runImportCustomEmojis(env, job);
    case "backfillInstances":
      return runBackfillInstancesStep(env, job);
    case "accountMove":
      return runAccountMoveStep(env, job);
    case "remoteFile":
      await runRemoteFileJob(env, job);
      return null;
    case "updateFeatured":
      await runUpdateFeaturedJob(env, job);
      return null;
    case "driveAlts":
      await runDriveAltsJob(env, job);
      return null;
    case "cleanRemoteNotes":
      return runCleanRemoteNotesStep(env, job);
    default:
      return null;
  }
}
