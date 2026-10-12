import { base64urlDecode, base64urlEncode } from '../lib/base64url';
import type { PublicEcJwk } from '../keys/types';

/**
 * Byte-level helpers for the Turnkey API-key credential the device key plays:
 * the public key in SEC1 compressed form and the signature in DER, which is
 * what a Turnkey stamp carries. Kept dependency-free so the SDK ships no
 * `@turnkey/*` package.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string has an odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) return bytes.subarray(bytes.length - 32);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

/** SEC1 compressed P-256 public key (33 bytes) as hex: `02`/`03` by the parity of Y, then X. */
export function compressedPublicKeyHex(jwk: PublicEcJwk): string {
  const x = leftPad32(base64urlDecode(jwk.x));
  const y = leftPad32(base64urlDecode(jwk.y));
  const prefix = (y[31]! & 1) === 0 ? '02' : '03';
  return prefix + bytesToHex(x);
}

/** A DER INTEGER from an unsigned big-endian value: strip leading zeros, keep the sign bit clear. */
function derInteger(value: Uint8Array): Uint8Array {
  let i = 0;
  while (i < value.length - 1 && value[i] === 0) i++;
  const trimmed = value.subarray(i);
  const needsPad = (trimmed[0]! & 0x80) !== 0;
  const out = new Uint8Array(2 + trimmed.length + (needsPad ? 1 : 0));
  out[0] = 0x02;
  out[1] = trimmed.length + (needsPad ? 1 : 0);
  if (needsPad) out[2] = 0;
  out.set(trimmed, needsPad ? 3 : 2);
  return out;
}

/** ECDSA signature from raw `r || s` (64 bytes, what WebCrypto and noble return) to DER. */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`expected a 64-byte r||s signature, got ${raw.length}`);
  const r = derInteger(raw.subarray(0, 32));
  const s = derInteger(raw.subarray(32));
  const out = new Uint8Array(2 + r.length + s.length);
  out[0] = 0x30;
  out[1] = r.length + s.length;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

/** The `X-Stamp` header value Turnkey expects: base64url of the stamp JSON. */
export function encodeStamp(stamp: { publicKey: string; scheme: string; signature: string }): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(stamp)));
}
