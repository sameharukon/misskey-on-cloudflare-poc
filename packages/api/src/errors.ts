/** Misskey-compatible API error JSON. */
export type ApiErrorBody = {
  message: string;
  code: string;
  id: string;
  kind?: "client" | "server" | "permission";
};

export function apiErrorResponse(
  err: ApiErrorBody,
  status = 400,
  info?: unknown,
): Response {
  return Response.json(
    { error: { ...err, ...(info !== undefined ? { info } : {}) } },
    { status },
  );
}

/** ApiCallService (no kind → "client"; sent with HTTP 401). */
export const CREDENTIAL_REQUIRED: ApiErrorBody = {
  message: "Credential required.",
  code: "CREDENTIAL_REQUIRED",
  id: "1384574d-a912-4b81-8601-c7b1c4085df1",
  // upstream ApiCallService: no kind (→ "client") and httpStatusCode 401
  kind: "client",
};

export const INTERNAL_ERROR: ApiErrorBody = {
  message: "Internal error occurred. Please contact us if the error persists.",
  code: "INTERNAL_ERROR",
  id: "5d37dbcb-891e-41ca-a3d6-e690c97775ac",
  kind: "server",
};

export const NO_SUCH_ENDPOINT: ApiErrorBody = {
  message: "No such endpoint.",
  code: "NO_SUCH_ENDPOINT",
  id: "00000000-0000-4000-8000-000000000001",
  kind: "client",
};

/** endpoint-base.ts (ajv validation failure). */
export const INVALID_PARAM: ApiErrorBody = {
  message: "Invalid param.",
  code: "INVALID_PARAM",
  // upstream endpoint-base.ts (ajv validation failure)
  id: "3d81ceae-475f-4600-b2a8-2bc116157532",
  kind: "client",
};

export const NO_SUCH_EMOJI: ApiErrorBody = {
  message: "No such emoji.",
  code: "NO_SUCH_EMOJI",
  id: "be83669b-773a-44b7-b1f8-e5e5170ac3c2",
  kind: "client",
};

export const ACCESS_DENIED: ApiErrorBody = {
  message: "Access denied.",
  code: "ACCESS_DENIED",
  id: "56f35758-7dd5-468b-8439-5d6fb8ec9b8e",
  kind: "permission",
};

/** ApiCallService: an access token without the endpoint's `kind`. */
export const APP_PERMISSION_DENIED: ApiErrorBody = {
  message: "Your app does not have the necessary permissions to use this endpoint.",
  code: "PERMISSION_DENIED",
  id: "1370e5b7-d4eb-4566-bb1d-7748ee6a1838",
  kind: "permission",
};

export const NO_SUCH_NOTE: ApiErrorBody = {
  message: "No such note.",
  code: "NO_SUCH_NOTE",
  id: "24fcbfc6-2e37-42b6-8388-c29b3861a08d",
  kind: "client",
};

export const NO_SUCH_USER: ApiErrorBody = {
  message: "No such user.",
  code: "NO_SUCH_USER",
  id: "4362f8dc-731f-4ad8-a945-bbbf821a5716",
  kind: "client",
};

export const ALREADY_REACTED: ApiErrorBody = {
  message: "You have already reacted to this note.",
  code: "ALREADY_REACTED",
  id: "00000000-0000-4000-8000-000000000010",
  kind: "client",
};

export const NOT_REACTED: ApiErrorBody = {
  message: "You have not reacted to this note.",
  code: "NOT_REACTED",
  id: "00000000-0000-4000-8000-000000000011",
  kind: "client",
};

export const NO_SUCH_FILE: ApiErrorBody = {
  message: "No such file.",
  code: "NO_SUCH_FILE",
  id: "00000000-0000-4000-8000-000000000020",
  kind: "client",
};

function clientErr(code: string, id: string, message: string): ApiErrorBody {
  return { message, code, id, kind: "client" };
}

/** Upstream following/*, blocking/*, mute/*, reactions error ids. */
export const FOLLOWEE_IS_YOURSELF = clientErr("FOLLOWEE_IS_YOURSELF", "26fbe7bb-a331-4857-af17-205b426669a9", "Followee is yourself.");
export const ALREADY_FOLLOWING = clientErr("ALREADY_FOLLOWING", "35387507-38c7-4cb9-9197-300b93783fa0", "You are already following that user.");
export const FOLLOW_BLOCKING = clientErr("BLOCKING", "4e2206ec-aa4f-4960-b865-6c23ac38e2d9", "You are blocking that user.");
export const FOLLOW_BLOCKED = clientErr("BLOCKED", "c4ab57cc-4e41-45e9-bfd9-584f61e35ce0", "You are blocked by that user.");
export const NOT_FOLLOWING = clientErr("NOT_FOLLOWING", "5dbf82f5-c92b-40b1-87d1-6c8c0741fd09", "You are not following that user.");
export const FOLLOW_REQUEST_NOT_FOUND = clientErr("FOLLOW_REQUEST_NOT_FOUND", "089b125b-d338-482a-9a09-e2622ac9f8d4", "Follow request not found.");
export const NO_FOLLOW_REQUEST = clientErr("NO_FOLLOW_REQUEST", "bcde4f8b-0913-4614-8881-614e522fb041", "No follow request.");
export const YOU_HAVE_BEEN_BLOCKED = clientErr("YOU_HAVE_BEEN_BLOCKED", "20ef5475-9f38-4e4c-bd33-de6d979498ec", "You cannot react this note because you have been blocked by this user.");
export const BLOCKEE_IS_YOURSELF = clientErr("BLOCKEE_IS_YOURSELF", "88b19138-f28d-42c0-8499-6a31bbd0fdc6", "Blockee is yourself.");
export const ALREADY_BLOCKING = clientErr("ALREADY_BLOCKING", "787fed64-acb9-464a-82eb-afbd745b9614", "You are already blocking that user.");
export const NOT_BLOCKING = clientErr("NOT_BLOCKING", "291b2efa-60c6-45c0-9f6a-045c8f9b02cd", "You are not blocking that user.");
export const MUTEE_IS_YOURSELF = clientErr("MUTEE_IS_YOURSELF", "a4619cb2-5f23-484b-9301-94c903074e10", "Mutee is yourself.");
export const ALREADY_MUTING = clientErr("ALREADY_MUTING", "7e7359cb-160c-4956-b08f-4d1c653cd007", "You are already muting that user.");
export const NOT_MUTING = clientErr("NOT_MUTING", "5467d020-daa9-4553-81e1-135c0c35a96d", "You are not muting that user.");

/** Upstream renote-mute/* error ids. */
export const RENOTE_MUTE_CREATE_NO_SUCH_USER = clientErr("NO_SUCH_USER", "5e0a5dff-1e94-4202-87ae-4d9c89eb2271", "No such user.");
export const RENOTE_MUTE_CREATE_MUTEE_IS_YOURSELF = clientErr("MUTEE_IS_YOURSELF", "37285718-52f7-4aef-b7de-c38b8e8a8420", "Mutee is yourself.");
export const RENOTE_MUTE_ALREADY_MUTING = clientErr("ALREADY_MUTING", "ccfecbe4-1f1c-4fc2-8a3d-c3ffee61cb7b", "You are already muting that user.");
export const RENOTE_MUTE_DELETE_NO_SUCH_USER = clientErr("NO_SUCH_USER", "9b6728cf-638c-4aa1-bedb-e07d8101474d", "No such user.");
export const RENOTE_MUTE_DELETE_MUTEE_IS_YOURSELF = clientErr("MUTEE_IS_YOURSELF", "619b1314-0850-4597-a242-e245f3da42af", "Mutee is yourself.");
export const RENOTE_MUTE_NOT_MUTING = clientErr("NOT_MUTING", "2e4ef874-8bf0-4b4b-b069-4598f6d05817", "You are not muting that user.");

/** ApiCallService `prohibitMoved` (403). */
export const YOUR_ACCOUNT_MOVED: ApiErrorBody = {
  message: "You have moved your account.",
  code: "YOUR_ACCOUNT_MOVED",
  id: "56f20ec9-fd06-4fa5-841b-edd6d7d4fa31",
  kind: "permission",
};
