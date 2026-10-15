import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { etc, sign, utils } from "@noble/secp256k1";

// Required for synchronous RFC6979 signing in @noble/secp256k1 v2.
etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error("invalid hex length");
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign a LightPool tx digest with the session agent key (AuthScheme::LightPoolNative).
 * Node verifies ECDSA over SHA256(tx_digest_bytes).
 */
export function signDigestNative(
  digestHex: string,
  agentPrivateKeyHex: string,
): string {
  const digest = hexToBytes(digestHex);
  if (digest.length !== 32) {
    throw new Error("tx digest must be 32 bytes");
  }
  const priv = hexToBytes(agentPrivateKeyHex);
  if (!utils.isValidPrivateKey(priv)) {
    throw new Error("invalid agent private key");
  }
  const msgHash = sha256(digest);
  const signature = sign(msgHash, priv);
  return `0x${bytesToHex(signature.toCompactRawBytes())}`;
}
