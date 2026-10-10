/**
 * Type-only bridge to upstream misskey-js autogen sources.
 * Requires `git submodule update --init upstream/misskey`.
 * No runtime code — do not import this from Workers bundles expecting JS.
 */

export type {
  MetaLite,
  MetaDetailed,
  MetaDetailedOnly,
  MetaClientOptions,
  UserLite,
  UserDetailed,
  UserDetailedNotMe,
  MeDetailed,
  User,
  Note,
  DriveFile,
  RolePolicies,
  Ad,
} from "../../../upstream/misskey/packages/misskey-js/src/autogen/models.js";

export type {
  MetaResponse,
  MetaRequest,
  IResponse,
  NotesShowRequest,
  NotesShowResponse,
  NotesTimelineRequest,
  NotesTimelineResponse,
  NotesLocalTimelineResponse,
  NotesHybridTimelineResponse,
} from "../../../upstream/misskey/packages/misskey-js/src/autogen/entities.js";
