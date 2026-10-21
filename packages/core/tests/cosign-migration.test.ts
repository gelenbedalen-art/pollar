// Moving a custodial Stellar wallet to Turnkey from the device's side (X7.8):
// the device offers its key as the sub-org's first credential and reads the
// quorum back afterwards, as it does for any new Turnkey wallet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CosignManager } from '../src/cosign/manager';

const DEVICE = '02' + 'ab'.repeat(32);
const DONE = {
  required: false,
  status: 'DONE',
  chain: 'STELLAR',
  address: 'GADDRESS',
  toCustody: 'COSIGNED',
  choice: false,
  error: null,
};

function harness() {
  const posts: Array<{ path: string; body: unknown }> = [];
  const order: string[] = [];
  const manager = new CosignManager({
    api: {
      GET: async () => ({ data: { content: { ...DONE, required: true, status: 'NONE' } } }),
      POST: async (path: string, init: { body: unknown }) => {
        posts.push({ path, body: init.body });
        order.push(path);
        return { data: { content: DONE } };
      },
    } as never,
    keyManager: {} as never,
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined } as never,
    networkPassphrase: () => 'Public Global Stellar Network ; September 2015',
    onRequest: () => undefined,
  });
  (manager as unknown as { publicKeyHex: () => Promise<string> }).publicKeyHex = async () => DEVICE;
  (manager as unknown as { inspectQuorum: () => Promise<unknown> }).inspectQuorum = async () => {
    order.push('inspectQuorum');
    return { ok: true };
  };
  return { manager, posts, order };
}

test('the move sends this device key and the pick, then reads the quorum back', async () => {
  const { manager, posts, order } = harness();
  const state = await manager.migrateWallet('SELF_CUSTODY');
  assert.equal(state.status, 'DONE');
  assert.deepEqual(posts, [{ path: '/cosign/custody/migration', body: { devicePublicKey: DEVICE, custody: 'SELF_CUSTODY' } }]);
  assert.deepEqual(order, ['/cosign/custody/migration', 'inspectQuorum']);
});

test('an app that picks the custody gets no pick from the device', async () => {
  const { manager, posts } = harness();
  await manager.migrateWallet();
  assert.deepEqual(posts[0]!.body, { devicePublicKey: DEVICE });
});

test('the status read says whether the wallet has to move', async () => {
  const { manager } = harness();
  const state = await manager.custodyMigration();
  assert.equal(state.required, true);
});
