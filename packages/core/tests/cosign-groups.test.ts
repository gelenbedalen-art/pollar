// Approval groups: what the device votes without asking again, after the user
// approved one request of a group. Pure: no network, no keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CosignGroupConsents, cosignGroupOf, stepInGroup } from '../src/cosign/groups';
import type { CosignRequest } from '../src/types';

const group = {
  id: 'stereum:t1:group:swap',
  title: 'Swap the USDT you received to USDC',
  steps: [
    { key: 'stereum:t1:approve:swap-usdt', label: 'Allow the swap to spend your USDT' },
    { key: 'stereum:t1:swap', label: 'Swap USDT to USDC in your wallet' },
  ],
};

const request = (stepKey: string, g: unknown = group) =>
  ({ id: stepKey, status: 'PENDING', stepKey, group: g }) as unknown as CosignRequest;

test('a step belongs to a group step by its key or that key as a prefix, never by a look-alike', () => {
  assert.ok(stepInGroup(group, 'stereum:t1:approve:swap-usdt:0'));
  assert.ok(stepInGroup(group, 'stereum:t1:swap'));
  assert.ok(!stepInGroup(group, 'stereum:t1:swap-usdc'), 'a key sharing letters is not the step');
  assert.ok(!stepInGroup(group, 'stereum:t1:burn'));
});

test('only a request with a well-formed group is grouped', () => {
  assert.deepEqual(cosignGroupOf(request('stereum:t1:swap')), group);
  assert.equal(cosignGroupOf(request('stereum:t1:swap', null)), null);
  assert.equal(cosignGroupOf(request('stereum:t1:swap', { id: 'x', title: 'y', steps: [] })), null);
});

test('after the user approves one step, the later steps of that group are covered, and nothing else', () => {
  const consents = new CosignGroupConsents();
  assert.equal(consents.covers(request('stereum:t1:swap')), false, 'nothing before the first approval');

  consents.grant(request('stereum:t1:approve:swap-usdt:0'));
  assert.equal(consents.covers(request('stereum:t1:swap')), true);
  assert.equal(consents.covers(request('stereum:t1:burn')), false, 'a step the user was not shown');

  // A request that claims the group but lists more steps than the user saw.
  const widened = { ...group, steps: [...group.steps, { key: 'stereum:t1:burn', label: 'Bridge' }] };
  assert.equal(consents.covers(request('stereum:t1:burn', widened)), false, 'only the steps the user saw count');

  const other = { ...group, id: 'stereum:t2:group:swap' };
  assert.equal(consents.covers(request('stereum:t1:swap', other)), false, 'another group is not covered');
});

test('a consent lapses, and survives a reload through its store', async () => {
  let now = 1_000;
  let saved: string | null = null;
  const store = { load: async () => saved, save: async (v: string) => void (saved = v) };
  const first = new CosignGroupConsents(store, 60_000, () => now);
  first.grant(request('stereum:t1:approve:swap-usdt:0'));
  await new Promise((r) => setTimeout(r, 0));

  const reloaded = new CosignGroupConsents(store, 60_000, () => now);
  await reloaded.load();
  assert.equal(reloaded.covers(request('stereum:t1:swap')), true, 'read back after a reload');

  now += 60_001;
  assert.equal(reloaded.covers(request('stereum:t1:swap')), false, 'expired');
});
