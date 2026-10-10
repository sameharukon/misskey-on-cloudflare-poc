/** RSA-2048 keypairs for local actors (upstream genRsaKeyPair: e = 65537, SPKI / PKCS#8 PEM). */

function pem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.replace(/.{64}/g, "$&\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
}

/** [publicKey, privateKey] as PEM, generated with WebCrypto (native and async in Workers). */
export async function genRsaPem(): Promise<[string, string]> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const [spki, pkcs8] = await Promise.all([crypto.subtle.exportKey("spki", kp.publicKey), crypto.subtle.exportKey("pkcs8", kp.privateKey)]);
  return [pem("PUBLIC KEY", spki as ArrayBuffer), pem("PRIVATE KEY", pkcs8 as ArrayBuffer)];
}
