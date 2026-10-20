// Which co-sign requests the device votes without asking the user. Pure: the
// manager's pending read runs against a stubbed API and a stubbed vote.
// Run with `npm test` in packages/core (or `npm run test:unit` at the root).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CosignManager } from '../src/cosign/manager';
import { autoApprovesCosignRequest } from '../src/cosign/recognize';
import type { CosignRequest } from '../src/types';

// A ramp leg: the swap of a co-signed Stereum on-ramp, on Polygon.
const rampStep = {
  id: 'ramp-swap',
  status: 'PENDING',
  kind: 'TX',
  network: 'POLYGON',
  intent: 'sign_and_send',
  operation: 'contract_call',
  stepKey: 'stereum:t1:swap',
  signWith: '0x2222222222222222222222222222222222222222',
  unsignedPayload: '02e281898001028252089444444444444444444444444444444444444444448203e880c0',
} as unknown as CosignRequest;

// Wallet setup the device recognizes: deriving the account of a chain the app enabled.
const setup = {
  id: 'add-solana',
  status: 'PENDING',
  kind: 'ACCOUNT',
  network: 'SOLANA',
  intent: 'add_accounts',
  signWith: 'x',
  unsignedPayload: '',
} as unknown as CosignRequest;

test('a ramp step is never voted without the user; recognized setup is', () => {
  assert.equal(autoApprovesCosignRequest(rampStep, { manual: false }), false);
  assert.equal(autoApprovesCosignRequest(setup, { manual: false }), true);
  // Under cosignManual the app votes on everything itself.
  assert.equal(autoApprovesCosignRequest(setup, { manual: true }), false);
});

test('the pending read votes the setup request and hands the ramp step to the user', async () => {
  let reads = 0;
  const shown: string[] = [];
  const voted: string[] = [];
  const manager = new CosignManager({
    api: {
      GET: async () => {
        reads++;
        // After the vote the setup request is gone; the ramp step still waits.
        return { data: { content: { requests: reads === 1 ? [rampStep, setup] : [rampStep] } } };
      },
    } as never,
    keyManager: {} as never,
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never,
    networkPassphrase: () => 'Test SDF Network ; September 2015',
    onRequest: (request) => shown.push(request.id),
    autoApprove: (request) => autoApprovesCosignRequest(request, { manual: false }),
  });
  (manager as unknown as { approve: (r: CosignRequest) => Promise<CosignRequest> }).approve = async (request) => {
    voted.push(request.id);
    return { ...request, status: 'APPROVED' } as CosignRequest;
  };

  const remaining = await manager.pending();

  assert.deepEqual(voted, ['add-solana']);
  assert.deepEqual(
    remaining.map((r) => r.id),
    ['ramp-swap'],
  );
  assert.ok(shown.includes('ramp-swap'), 'the ramp step is handed to the UI to ask the user');
  assert.ok(!shown.includes('add-solana'), 'the recognized setup never reaches the prompt');
});
