/**
 * Tests: headers for an inbox POST that pass the route's checks (signature header, host, date,
 * digest), signed with a throwaway key, so the signature itself does not verify.
 */
import { exportPkcs8Pem, generateRsaKeyPair, signedPostHeaders } from "../../ap/src/index.js";

let pem: Promise<string> | null = null;

export async function signedInboxHeaders(url: string, body: string, keyId = "https://r.example/users/x#main-key"): Promise<Record<string, string>> {
  pem ??= generateRsaKeyPair().then((kp) => exportPkcs8Pem(kp.privateKey));
  return signedPostHeaders({ privateKeyPem: await pem, keyId, url, body });
}
