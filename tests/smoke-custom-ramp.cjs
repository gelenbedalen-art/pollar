const assert = require('node:assert/strict');
const sdk = require('../packages/core/dist/index.js');
const portable = require('@pollar/core/ramps');

(async () => {
  const adapter = portable.defineRampAdapter({
    adapterId: 'third-party',
    async capabilities() {
      return {
        routes: [],
        callbacks: false,
        polling: true,
        providerIdempotency: false,
        operationLookup: false,
        fiatPayoutEvidence: false,
        keyRetentionSeconds: null,
        refunds: 'api',
      };
    },
    async quote() {
      throw new Error('Not used');
    },
    async create() {
      throw new Error('Not used');
    },
    async status() {
      throw new Error('Not used');
    },
    async reconcile() {
      return null;
    },
    async refund() {
      return { outcome: 'rejected', error: new portable.RampAdapterError('PROVIDER_REJECTED', 'operator') };
    },
  });
  const user = {
    applicationId: 'app',
    sdkUserId: 'user',
    providerId: 'provider',
    configurationId: 'config',
    wallet: { address: 'wallet', chain: 'STELLAR', network: 'testnet', custody: 'external' },
  };
  const refund = {
    user,
    operation: { operationId: 'op', idempotencyKey: 'key', transactionId: 'tx', providerOrderRef: 'order' },
    authorizationRef: 'approved',
    amount: '1',
    currency: 'USD',
  };
  const client = new sdk.PollarClient({ apiKey: 'fixture', logLevel: 'silent', rampAdapters: [adapter] });
  assert.equal(client.rampAdapters.has(adapter.adapterId), true);
  const result = await client.rampAdapters.refund(adapter.adapterId, refund);
  assert.equal(result.outcome, 'rejected');
  assert.equal(sdk.isRampAdapterError(result.error), true);
  assert.equal(portable.isRampAdapterError(result.error), true);
  const remove = client.registerRampAdapter({ ...adapter, adapterId: 'other' });
  remove();
  assert.equal(client.rampAdapters.has('other'), false);
  client.destroy();
  assert.equal(client.rampAdapters.has(adapter.adapterId), false);
  assert.throws(() => client.registerRampAdapter(adapter), /destroyed/);

  const esm = await import('@pollar/core/ramps');
  const native = require('../packages/core/dist/index.rn.js');
  assert.equal(esm.isRampAdapterError(new portable.RampAdapterError('INVALID_INPUT', 'correct_input')), true);
  assert.equal(native.isRampAdapterError(new esm.RampAdapterError('INVALID_INPUT', 'correct_input')), true);
  assert.equal(typeof native.RampAdapterClient, 'function');
  assert.equal(Object.keys(portable).includes('PollarClient'), false);
  console.log('Custom ramp: root/native/portable exports, cross-bundle errors, config, registration and cleanup passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
