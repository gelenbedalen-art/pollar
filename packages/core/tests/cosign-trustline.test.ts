// A trustline on an embedded wallet is a signature like any other: the user
// confirms it first, a co-signed vote the client casts itself never flashes
// the prompt, and the request sdk-api opens for the next enabled asset is read
// as soon as the previous setup step lands.
// Run with `npm test` in packages/core (or `npm run test:unit` at the root).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PollarClient } from '../src/index';
import type { CosignRequest, CosignState } from '../src/types';

const USDC = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' };

const trustlineRequest = {
  id: 'trust-usdc',
  status: 'PENDING',
  kind: 'TX',
  network: 'STELLAR',
  intent: 'sign_and_send',
  operation: 'change_trust',
  signWith: 'G',
  unsignedPayload: '',
  activityId: null,
} as unknown as CosignRequest;

type Probe = {
  _session: unknown;
  _api: { POST: (path: string, init: unknown) => Promise<unknown> };
  _confirm: (input: Record<string, unknown>) => Promise<{ ok: boolean; code?: string; details?: string }>;
  _settleCosign: (request: CosignRequest, ctx: unknown) => Promise<unknown>;
  _noteCosignRequest: (request: CosignRequest) => void;
  cosign: { pending: () => Promise<CosignRequest[]> };
  onCosignStateChange: (cb: (state: CosignState) => void) => () => void;
  setTrustline: PollarClient['setTrustline'];
};

function embeddedClient(config: Record<string, unknown> = {}) {
  const client = new PollarClient({ apiKey: 'pub_testnet_probe', ...config } as never) as unknown as Probe;
  client._session = { wallet: { type: 'internal', address: 'GUSER' } };
  const posted: string[] = [];
  const asked: Array<Record<string, unknown>> = [];
  let pendingReads = 0;
  client._confirm = async (input) => {
    asked.push(input);
    return { ok: true };
  };
  client.cosign.pending = async () => {
    pendingReads++;
    return [];
  };
  return { client, posted, asked, pendingReads: () => pendingReads };
}

test('a trustline on an embedded wallet is put to the user before the server is called', async () => {
  const { client, posted, asked } = embeddedClient();
  client._api = {
    POST: async (path) => {
      posted.push(path);
      return { data: { code: 'SDK_WALLET_TRUSTLINE' } };
    },
  };

  assert.deepEqual(await client.setTrustline(USDC), { status: 'success' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.operation, 'change_trust');
  assert.deepEqual(posted, ['/wallet/assets/trustline']);
});

test('a declined trustline never reaches the server', async () => {
  const { client, posted } = embeddedClient();
  client._confirm = async () => ({
    ok: false,
    code: 'SDK_CONFIRMATION_DECLINED',
    details: 'the user declined the transaction',
  });
  client._api = {
    POST: async (path) => {
      posted.push(path);
      return { data: { code: 'SDK_WALLET_TRUSTLINE' } };
    },
  };

  const outcome = await client.setTrustline(USDC);

  assert.equal(outcome.status, 'error');
  assert.equal((outcome as { code?: string }).code, 'SDK_CONFIRMATION_DECLINED');
  assert.deepEqual(posted, []);
});

test('the co-signed request a trustline answers with is voted by the client, never offered in the prompt', async () => {
  const { client } = embeddedClient();
  client._api = {
    POST: async () => ({
      data: { code: 'SDK_COSIGN_PENDING', content: { pendingSignature: { kind: 'cosign', request: trustlineRequest } } },
    }),
  };
  const offered: string[][] = [];
  client.onCosignStateChange((state) => offered.push(state.pending.map((r) => r.id)));
  const settled: string[] = [];
  client._settleCosign = async (request) => {
    settled.push(request.id);
    return { status: 'success' };
  };

  await client.setTrustline(USDC);

  assert.deepEqual(settled, ['trust-usdc']);
  assert.ok(
    offered.every((ids) => !ids.includes('trust-usdc')),
    'the request never entered the pending list',
  );
});

test('an app that votes itself still gets the request in the pending list', async () => {
  const { client } = embeddedClient({ cosignManual: true });
  client._api = {
    POST: async () => ({
      data: { code: 'SDK_COSIGN_PENDING', content: { pendingSignature: { kind: 'cosign', request: trustlineRequest } } },
    }),
  };
  const offered: string[][] = [];
  client.onCosignStateChange((state) => offered.push(state.pending.map((r) => r.id)));

  const outcome = await client.setTrustline(USDC);

  assert.equal(outcome.status, 'cosign_pending');
  assert.ok(offered.some((ids) => ids.includes('trust-usdc')));
});

const landed = (over: Record<string, unknown>) =>
  ({
    ...trustlineRequest,
    status: 'APPROVED',
    submit: { hash: 'h', status: 'SUCCESS' },
    ...over,
  }) as unknown as CosignRequest;

test('a created account or an added trustline reads the next setup request once', async () => {
  const { client, pendingReads } = embeddedClient();

  client._noteCosignRequest(landed({ id: 'acct', intent: 'account_create', operation: 'create_account' }));
  client._noteCosignRequest(landed({ id: 'trust-usdc' }));
  // The same final copy arriving again (a later read) reads nothing more.
  client._noteCosignRequest(landed({ id: 'trust-usdc' }));

  assert.equal(pendingReads(), 2);
});

test('nothing is read after a failed setup step, any other send, or for an app that votes itself', async () => {
  const { client, pendingReads } = embeddedClient();
  client._noteCosignRequest(landed({ id: 'failed', submit: { hash: 'h', status: 'FAILED' } }));
  client._noteCosignRequest(landed({ id: 'rejected', status: 'REJECTED', submit: undefined }));
  client._noteCosignRequest(landed({ id: 'payment', operation: 'payment' }));
  assert.equal(pendingReads(), 0);

  const manual = embeddedClient({ cosignManual: true });
  manual.client._noteCosignRequest(landed({ id: 'trust-usdc' }));
  assert.equal(manual.pendingReads(), 0);
});
