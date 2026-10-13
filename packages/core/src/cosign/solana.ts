import { bytesToHex, hexToBytes } from './encoding';

/**
 * The device's own reading of a Solana co-sign request that carries a CCTP
 * burn: the unsigned transaction decoded by hand (Solana's wire format, no
 * Solana library), and the burn checked against what the request says it is.
 * A shape this reader does not know is "not recognized", never guessed, and is
 * not approved.
 */

/** Circle's CCTP V2 TokenMessengerMinter: the program a ramp's burn calls. */
export const TOKEN_MESSENGER_MINTER_V2 = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** sha256("global:deposit_for_burn")[0..8], from Circle's V2 IDL. */
const DEPOSIT_FOR_BURN = 'd73c3d2e723780b0';
/** Positions in deposit_for_burn's account list (the IDL's order). */
const OWNER = 0;
const EVENT_RENT_PAYER = 1;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** A 32-byte public key as its base58 address. */
export function base58Of(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    if (this.offset >= this.bytes.length) throw new Error('solana: unexpected end');
    return this.bytes[this.offset++]!;
  }

  /** Solana's compact-u16 (shortvec) length. */
  compactU16(): number {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('solana: compact-u16 too long');
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error('solana: unexpected end');
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

export interface DecodedSolanaInstruction {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

export interface DecodedSolanaTransaction {
  /** The fee payer: the first account key. */
  feePayer: string;
  instructions: DecodedSolanaInstruction[];
}

/**
 * A serialized (unsigned) legacy or v0 transaction. Address lookup tables are
 * refused unless `allowLookupTables`: then an account loaded from one reads as
 * '' (a program never comes from a table, so the programs stay exact).
 */
export function decodeSolanaTransaction(hex: string, options?: { allowLookupTables?: boolean }): DecodedSolanaTransaction {
  const lenient = options?.allowLookupTables === true;
  const r = new Reader(hexToBytes(hex.replace(/^0x/i, '')));
  const signatures = r.compactU16();
  r.take(signatures * 64);

  const first = r.u8();
  const versioned = (first & 0x80) !== 0;
  if (versioned && (first & 0x7f) !== 0) throw new Error(`solana: message version ${first & 0x7f} is not supported`);
  if (versioned) r.u8(); // numRequiredSignatures
  r.u8(); // numReadonlySignedAccounts
  r.u8(); // numReadonlyUnsignedAccounts

  const keyCount = r.compactU16();
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) keys.push(base58Of(r.take(32)));
  r.take(32); // recent blockhash

  const instructions: DecodedSolanaInstruction[] = [];
  const count = r.compactU16();
  for (let i = 0; i < count; i++) {
    const programIndex = r.u8();
    const accountCount = r.compactU16();
    const accounts: string[] = [];
    for (let a = 0; a < accountCount; a++) {
      const key = keys[r.u8()];
      if (!key && !lenient) throw new Error('solana: account index out of range');
      accounts.push(key ?? '');
    }
    const data = r.take(r.compactU16());
    const program = keys[programIndex];
    if (!program) throw new Error('solana: program index out of range');
    instructions.push({ program, accounts, data });
  }
  const lookups = versioned ? r.compactU16() : 0;
  if (lookups !== 0 && !lenient) throw new Error('solana: address lookup tables are not supported');
  if (lookups === 0 && !r.done) throw new Error('solana: trailing bytes');
  const feePayer = keys[0];
  if (!feePayer) throw new Error('solana: no fee payer');
  return { feePayer, instructions };
}

function u64le(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = v * 256n + BigInt(bytes[i]!);
  return v;
}

function u32le(bytes: Uint8Array): number {
  return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
}

const hex32 = (value: unknown) => (typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : null);

/**
 * Check a Solana request before voting. A request declared as a CCTP burn
 * (`operation: 'cctp_burn'`) must hold exactly one deposit_for_burn and nothing
 * but compute-budget instructions beside it, burn from the signing account,
 * have the fee and the event account's rent paid by the account the request
 * names, and burn the amount to the domain and recipient the request states.
 * Any other request must not call the token messenger at all: a burn always
 * says it is one. A payload this reader cannot decode is left to the
 * byte-for-byte comparison with what Turnkey holds, as before.
 */
export function checkSolanaRequest(
  unsignedPayload: string,
  request: { operation?: string | undefined; details?: Record<string, unknown> | undefined; signWith: string },
): { ok: true } | { ok: false; reason: string } {
  if (request.operation !== 'cctp_burn') {
    // Any other request keeps the byte-for-byte check against Turnkey's payload;
    // what is added here is only that it must not call the token messenger.
    let other: DecodedSolanaTransaction;
    try {
      other = decodeSolanaTransaction(unsignedPayload, { allowLookupTables: true });
    } catch {
      return { ok: true };
    }
    return other.instructions.some((ix) => ix.program === TOKEN_MESSENGER_MINTER_V2)
      ? { ok: false, reason: 'a CCTP burn the request does not declare' }
      : { ok: true };
  }

  let tx: DecodedSolanaTransaction;
  try {
    tx = decodeSolanaTransaction(unsignedPayload);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const burns = tx.instructions.filter((ix) => ix.program === TOKEN_MESSENGER_MINTER_V2);

  if (tx.instructions.some((ix) => ix.program !== TOKEN_MESSENGER_MINTER_V2 && ix.program !== COMPUTE_BUDGET)) {
    return { ok: false, reason: 'the burn carries an instruction for another program' };
  }
  if (burns.length !== 1) return { ok: false, reason: `expected one deposit_for_burn, found ${burns.length}` };
  const burn = burns[0]!;
  if (burn.data.length < 52 || bytesToHex(burn.data.subarray(0, 8)) !== DEPOSIT_FOR_BURN) {
    return { ok: false, reason: 'not a deposit_for_burn' };
  }
  if (burn.accounts[OWNER] !== request.signWith)
    return { ok: false, reason: 'the burn does not leave from the signing account' };

  const details = request.details ?? {};
  const payer = typeof details.feePayer === 'string' ? details.feePayer : null;
  if (!payer || tx.feePayer !== payer || burn.accounts[EVENT_RENT_PAYER] !== payer) {
    return { ok: false, reason: 'the fee or the event rent is not paid by the account the request names' };
  }
  const amount = u64le(burn.data.subarray(8, 16));
  const domain = u32le(burn.data.subarray(16, 20));
  const recipient = bytesToHex(burn.data.subarray(20, 52));
  if (String(amount) !== String(details.amount)) return { ok: false, reason: 'the amount is not the one the request states' };
  if (domain !== Number(details.destinationDomain))
    return { ok: false, reason: 'the destination domain is not the one the request states' };
  if (recipient !== hex32(details.mintRecipient))
    return { ok: false, reason: 'the mint recipient is not the one the request states' };
  return { ok: true };
}
