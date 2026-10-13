// The device's reading of a Polygon co-sign request. Pure: no network, no keys.
// Run with tsx (the package has no test runner of its own):
//   npx tsx --test packages/core/tests/cosign-evm.test.ts
// The vectors were serialized with viem's serializeTransaction.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEvmRequest, decodeUnsignedEip1559, polygonChainIdFor, recognizeEvmCall } from '../src/cosign/evm';

const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const TOKEN_MESSENGER = '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d';
// approve(TokenMessengerV2, 996000) on Polygon USDC, chain 137, nonce 7.
const APPROVE_DATA =
  '0x095ea7b300000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d00000000000000000000000000000000000000000000000000000000000f32a0';
const APPROVE_TX =
  '0x02f86f8189078506fc23ac00850df847580082fde8943c499c542cef5e3811e1192ce70d8cc03d5c335980b844' + APPROVE_DATA.slice(2) + 'c0';
// 1000 wei of POL to 0x4444..., chain 137, nonce 0.
const NATIVE_TX = '0x02e281898001028252089444444444444444444444444444444444444444448203e880c0';
const MAINNET = 'Public Global Stellar Network ; September 2015';

test('an unsigned EIP-1559 transaction decodes field by field, with or without 0x', () => {
  for (const hex of [APPROVE_TX, APPROVE_TX.slice(2)]) {
    const tx = decodeUnsignedEip1559(hex);
    assert.equal(tx.chainId, 137n);
    assert.equal(tx.nonce, 7n);
    assert.equal(tx.maxPriorityFeePerGas, 30_000_000_000n);
    assert.equal(tx.maxFeePerGas, 60_000_000_000n);
    assert.equal(tx.gas, 65_000n);
    assert.equal(tx.to, USDC);
    assert.equal(tx.value, 0n);
    assert.equal(tx.data, APPROVE_DATA);
    assert.equal(tx.accessListLength, 0);
  }
  const native = decodeUnsignedEip1559(NATIVE_TX);
  assert.equal(native.value, 1000n);
  assert.equal(native.data, '0x');
});

test('anything that is not an unsigned type-2 transaction is refused', () => {
  assert.throws(() => decodeUnsignedEip1559('0x01' + APPROVE_TX.slice(4)), /type-2/);
  assert.throws(() => decodeUnsignedEip1559(APPROVE_TX + '00'), /trailing/);
  assert.throws(() => decodeUnsignedEip1559(APPROVE_TX.slice(0, 40)), /past the end|unexpected end/);
});

test('only the calls the platform asks for are recognized', () => {
  assert.deepEqual(recognizeEvmCall({ to: USDC, value: 0n, data: APPROVE_DATA }), { ok: true, kind: 'erc20_approve' });
  assert.deepEqual(recognizeEvmCall({ to: USDC, value: 5n, data: '0x' }), { ok: true, kind: 'native_transfer' });
  assert.equal(recognizeEvmCall({ to: USDC, value: 0n, data: '0xdeadbeef' + '00'.repeat(64) }).ok, false);
  assert.equal(recognizeEvmCall({ to: USDC, value: 1n, data: APPROVE_DATA }).ok, false, 'a call that also sends POL');
  assert.equal(recognizeEvmCall({ to: null, value: 0n, data: APPROVE_DATA }).ok, false, 'a contract creation');
  assert.equal(recognizeEvmCall({ to: USDC, value: 0n, data: APPROVE_DATA.slice(0, -2) }).ok, false, 'truncated arguments');
});

test('a request is approved only when its payload makes exactly the call it describes, on this network', () => {
  const details = { to: USDC, value: '0', data: APPROVE_DATA };
  const ok = checkEvmRequest(APPROVE_TX.slice(2), details, polygonChainIdFor(MAINNET));
  assert.equal(ok.ok, true);

  assert.equal(checkEvmRequest(APPROVE_TX, { ...details, to: TOKEN_MESSENGER }, 137n).ok, false, 'another destination');
  assert.equal(checkEvmRequest(APPROVE_TX, { ...details, value: '1' }, 137n).ok, false, 'another value');
  assert.equal(checkEvmRequest(APPROVE_TX, { ...details, data: APPROVE_DATA.replace('f32a0', 'f32a1') }, 137n).ok, false);
  assert.equal(checkEvmRequest(APPROVE_TX, {}, 137n).ok, false, 'a request that states no call');
  assert.equal(checkEvmRequest(APPROVE_TX, details, polygonChainIdFor('Test SDF Network ; September 2015')).ok, false);
});
