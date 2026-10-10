/**
 * ActivityPub building blocks shared by the Workers: HTTP Signatures, renderers, inbox parsing
 * and SSRF checks (the api Worker's federation uses them), plus WebFinger resource parsing.
 */
export function isActivityPubRequest(accept: string | null): boolean {
  if (!accept) return false;
  return (
    accept.includes("application/activity+json") ||
    accept.includes("application/ld+json")
  );
}

export { parseAcctResource } from "./discovery.js";

export {
  parseSignatureHeader,
  formatSignatureHeader,
  buildSigningString,
  generateRsaKeyPair,
  exportSpkiPem,
  importSpkiPem,
  signRequest,
  verifyRequest,
  importPkcs8Pem,
  exportPkcs8Pem,
  digestHeader,
  signedPostHeaders,
  signedGetHeaders,
  precheckIncoming,
  type IncomingCheck,
  type HttpSignatureParams,
} from "./http-signature.js";

export * from "./renderer.js";
export * from "./inbox-parse.js";
