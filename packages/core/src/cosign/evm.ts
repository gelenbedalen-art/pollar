import { hexToBytes, bytesToHex } from './encoding';

/**
 * The device's own reading of a Polygon co-sign request: the unsigned EIP-1559
 * transaction decoded by hand (RLP, no EVM library), and the call it makes
 * recognized against the few the platform ever asks a co-signed wallet to sign.
 * A shape this reader does not know is "not recognized", never guessed, and is
 * not approved.
 */

type RlpItem = Uint8Array | RlpItem[];

function readLength(bytes: Uint8Array, offset: number, lengthOfLength: number): number {
  if (offset + lengthOfLength > bytes.length) throw new Error('rlp: unexpected end');
  let length = 0;
  for (let i = 0; i < lengthOfLength; i++) length = length * 256 + bytes[offset + i]!;
  return length;
}

/** Decode one RLP item at `offset`; returns it and the offset just past it. */
function decodeAt(bytes: Uint8Array, offset: number): { item: RlpItem; next: number } {
  if (offset >= bytes.length) throw new Error('rlp: unexpected end');
  const prefix = bytes[offset]!;
  if (prefix < 0x80) return { item: bytes.subarray(offset, offset + 1), next: offset + 1 };
  if (prefix <= 0xb7) {
    const length = prefix - 0x80;
    const end = offset + 1 + length;
    if (end > bytes.length) throw new Error('rlp: string past the end');
    return { item: bytes.subarray(offset + 1, end), next: end };
  }
  if (prefix <= 0xbf) {
    const lengthOfLength = prefix - 0xb7;
    const length = readLength(bytes, offset + 1, lengthOfLength);
    const start = offset + 1 + lengthOfLength;
    if (start + length > bytes.length) throw new Error('rlp: string past the end');
    return { item: bytes.subarray(start, start + length), next: start + length };
  }
  let start: number;
  let length: number;
  if (prefix <= 0xf7) {
    length = prefix - 0xc0;
    start = offset + 1;
  } else {
    const lengthOfLength = prefix - 0xf7;
    length = readLength(bytes, offset + 1, lengthOfLength);
    start = offset + 1 + lengthOfLength;
  }
  const end = start + length;
  if (end > bytes.length) throw new Error('rlp: list past the end');
  const items: RlpItem[] = [];
  let cursor = start;
  while (cursor < end) {
    const { item, next } = decodeAt(bytes, cursor);
    items.push(item);
    cursor = next;
  }
  if (cursor !== end) throw new Error('rlp: list length mismatch');
  return { item: items, next: end };
}

function asBytes(item: RlpItem | undefined, field: string): Uint8Array {
  if (!(item instanceof Uint8Array)) throw new Error(`eip1559: ${field} is not a byte string`);
  return item;
}

function asBigInt(item: RlpItem | undefined, field: string): bigint {
  const bytes = asBytes(item, field);
  return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}

export interface UnsignedEip1559 {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  /** Lowercase 0x address; null for a contract creation, which nothing here asks for. */
  to: string | null;
  value: bigint;
  /** Lowercase 0x calldata. */
  data: string;
  accessListLength: number;
}

/** Decode an unsigned EIP-1559 transaction (`0x02 || rlp([...9 fields])`), with or without the 0x prefix. */
export function decodeUnsignedEip1559(hex: string): UnsignedEip1559 {
  const clean = hex.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean)) throw new Error('eip1559: payload is not hex');
  const bytes = hexToBytes(clean);
  if (bytes[0] !== 0x02) throw new Error('eip1559: not a type-2 transaction');
  const { item, next } = decodeAt(bytes, 1);
  if (next !== bytes.length) throw new Error('eip1559: trailing bytes');
  if (!Array.isArray(item) || item.length !== 9) throw new Error('eip1559: expected 9 fields (an unsigned transaction)');
  const to = asBytes(item[5], 'to');
  if (to.length !== 0 && to.length !== 20) throw new Error('eip1559: to is not an address');
  const accessList = item[8];
  if (!Array.isArray(accessList)) throw new Error('eip1559: accessList is not a list');
  return {
    chainId: asBigInt(item[0], 'chainId'),
    nonce: asBigInt(item[1], 'nonce'),
    maxPriorityFeePerGas: asBigInt(item[2], 'maxPriorityFeePerGas'),
    maxFeePerGas: asBigInt(item[3], 'maxFeePerGas'),
    gas: asBigInt(item[4], 'gas'),
    to: to.length === 0 ? null : `0x${bytesToHex(to)}`,
    value: asBigInt(item[6], 'value'),
    data: `0x${bytesToHex(asBytes(item[7], 'data'))}`,
    accessListLength: accessList.length,
  };
}

/** The calls a co-signed Polygon wallet is ever asked to make, by 4-byte selector. */
const KNOWN_SELECTORS: Record<string, { kind: EvmCallKind; minArgsWords: number }> = {
  // ERC-20 transfer(address,uint256)
  '0xa9059cbb': { kind: 'erc20_transfer', minArgsWords: 2 },
  // ERC-20 approve(address,uint256)
  '0x095ea7b3': { kind: 'erc20_approve', minArgsWords: 2 },
  // Uniswap V3 SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  '0x04e45aaf': { kind: 'swap_exact_input_single', minArgsWords: 7 },
  // CCTP V2 TokenMessengerV2 depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
  '0x8e0250ee': { kind: 'cctp_deposit_for_burn', minArgsWords: 7 },
  // CCTP V2 TokenMessengerV2 depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)
  '0x779b432d': { kind: 'cctp_deposit_for_burn_with_hook', minArgsWords: 8 },
};

export type EvmCallKind =
  | 'native_transfer'
  | 'erc20_transfer'
  | 'erc20_approve'
  | 'swap_exact_input_single'
  | 'cctp_deposit_for_burn'
  | 'cctp_deposit_for_burn_with_hook';

export type EvmCallRecognition = { ok: true; kind: EvmCallKind } | { ok: false; reason: string };

/** Which known call a transaction makes, or why it is not one. */
export function recognizeEvmCall(tx: Pick<UnsignedEip1559, 'to' | 'value' | 'data'>): EvmCallRecognition {
  if (!tx.to) return { ok: false, reason: 'a contract creation is never asked of a co-signed wallet' };
  if (tx.data === '0x') return { ok: true, kind: 'native_transfer' };
  // A contract call that also moves POL is not one of the platform's.
  if (tx.value !== 0n) return { ok: false, reason: 'a contract call that also sends POL is not recognized' };
  const selector = tx.data.slice(0, 10);
  const known = KNOWN_SELECTORS[selector];
  if (!known) return { ok: false, reason: `the call ${selector} is not one this device recognizes` };
  const argsHex = tx.data.length - 10;
  if (argsHex % 64 !== 0 || argsHex / 64 < known.minArgsWords) {
    return { ok: false, reason: `the ${known.kind} arguments are malformed` };
  }
  return { ok: true, kind: known.kind };
}

/** Polygon's chain id for the app's network: mainnet, or Amoy for testnet. */
export function polygonChainIdFor(networkPassphrase: string): bigint {
  return networkPassphrase.startsWith('Public Global Stellar Network') ? 137n : 80002n;
}

export type EvmRequestCheck = { ok: true; kind: EvmCallKind; tx: UnsignedEip1559 } | { ok: false; reason: string };

/**
 * Check a Polygon request's payload on its own terms: it decodes as an unsigned
 * EIP-1559 transaction for this network's chain, it makes a call this device
 * recognizes, and its destination, value and calldata are exactly the ones the
 * request says it carries (`details.to`, `details.value`, `details.data`), so
 * what the user is shown is what gets signed.
 */
export function checkEvmRequest(
  payload: string,
  details: Record<string, unknown> | undefined,
  expectedChainId: bigint,
): EvmRequestCheck {
  let tx: UnsignedEip1559;
  try {
    tx = decodeUnsignedEip1559(payload);
  } catch (err) {
    return { ok: false, reason: `the transaction is not readable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (tx.chainId !== expectedChainId) {
    return { ok: false, reason: `the transaction is for chain ${tx.chainId}, not ${expectedChainId}` };
  }
  if (tx.accessListLength !== 0) return { ok: false, reason: 'an access list is never part of a platform transaction' };
  const recognized = recognizeEvmCall(tx);
  if (!recognized.ok) return recognized;

  const to = typeof details?.to === 'string' ? details.to.toLowerCase() : null;
  const data = typeof details?.data === 'string' ? details.data.toLowerCase() : null;
  const value = typeof details?.value === 'string' && /^\d+$/.test(details.value) ? BigInt(details.value) : null;
  if (to === null || data === null || value === null) {
    return { ok: false, reason: 'the request does not state the call it carries' };
  }
  if (tx.to !== to || tx.data !== data || tx.value !== value) {
    return { ok: false, reason: 'the transaction does not make the call the request describes' };
  }
  return { ok: true, kind: recognized.kind, tx };
}
