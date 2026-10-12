const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const core = require('../packages/core/package.json');
  assert.equal(core.dependencies['@stellar/stellar-base'], undefined);
  for (const entry of ['index.js', 'index.rn.js']) {
    const artifact = path.join(__dirname, '../packages/core/dist', entry);
    const sourceMap = JSON.parse(fs.readFileSync(artifact + '.map', 'utf8'));
    assert.equal(
      sourceMap.sources.some((source) => source.includes('@stellar/stellar-base/')),
      false,
      'Core must not bundle the Stellar XDR parser',
    );
    const { PollarClient } = require(artifact);
    const client = new PollarClient({ apiKey: 'fixture', logLevel: 'silent' });
    client.destroy();
    let signs = 0;
    let continuations = 0;
    let builtInSigns = 0;
    let refusal = null;
    let snapshot = {
      txId: 'fixture',
      status: 'pending',
      transactionVersion: 1,
      nextAction: {
        kind: 'sign_transaction',
        actionId: 'fixture-action',
        chain: 'STELLAR',
        network: 'testnet',
        purpose: 'authentication',
        payload: { encoding: 'xdr', value: 'opaque-to-core' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    client.getRampTransaction = async () => snapshot;
    client.signTx = async () => {
      builtInSigns++;
      throw new Error('Core must not use a built-in chain signer');
    };
    client.continueRamp = async (txId, body) => {
      assert.equal(txId, snapshot.txId);
      assert.deepEqual(body, {
        actionId: snapshot.nextAction.actionId,
        transactionVersion: snapshot.transactionVersion,
        signedPayload: 'integration-signed',
      });
      continuations++;
      return { ...snapshot, transactionVersion: 2 };
    };
    await client.getRampTransaction(snapshot.txId);
    assert.equal(signs, 0);
    await assert.rejects(client.signRampAction(snapshot.txId, snapshot), /Register a ramp signing handler for STELLAR\/xdr/);
    assert.equal(builtInSigns, 0);
    assert.equal(continuations, 0);
    const cleanup = client.registerRampSigningHandler('STELLAR', 'xdr', async (action) => {
      // Account, payload and network validation belongs to this integration.
      if (refusal) throw new Error(refusal);
      assert.equal(action, snapshot.nextAction);
      assert.equal(action.payload.value, 'opaque-to-core');
      signs++;
      return 'integration-signed';
    });
    const originalBuffer = globalThis.Buffer;
    if (entry === 'index.rn.js') globalThis.Buffer = undefined;
    try {
      // Cached payloads are never sent to the signer, even with a matching action/version.
      const cached = {
        ...snapshot,
        nextAction: { ...snapshot.nextAction, payload: { encoding: 'xdr', value: 'stale-cached-payload' } },
      };
      await client.signRampAction(snapshot.txId, cached);
      assert.equal(signs, 1);
      assert.equal(continuations, 1);
      assert.equal(builtInSigns, 0);
      await assert.rejects(client.signRampAction(snapshot.txId, { ...snapshot, transactionVersion: 0 }), /action changed/);
      assert.equal(signs, 1);
      for (const reason of ['Wrong wallet account', 'Wrong network', 'Wallet declined the request']) {
        refusal = reason;
        await assert.rejects(client.signRampAction(snapshot.txId, snapshot), (error) => error.message === reason);
        assert.equal(continuations, 1);
        assert.equal(signs, 1);
      }
      refusal = null;
      const original = snapshot;
      for (const change of [
        { status: 'completed' },
        { reconciliationRequired: true },
        { nextAction: { ...original.nextAction, expiresAt: '2000-01-01T00:00:00Z' } },
      ]) {
        snapshot = { ...original, ...change };
        await assert.rejects(client.signRampAction(snapshot.txId, snapshot), /action changed/);
        assert.equal(continuations, 1);
      }
      snapshot = { ...original, nextAction: { ...original.nextAction, payload: { encoding: 'other', value: 'opaque' } } };
      await assert.rejects(
        client.signRampAction(snapshot.txId, snapshot),
        /Register a ramp signing handler for STELLAR\/other/,
      );
      snapshot = original;
      cleanup();
      await assert.rejects(client.signRampAction(snapshot.txId, snapshot), /Register a ramp signing handler/);
      assert.equal(builtInSigns, 0);
      assert.equal(signs, 1);
      assert.equal(continuations, 1);
    } finally {
      globalThis.Buffer = originalBuffer;
      cleanup();
    }
  }
  console.log(
    'Ramp signing: opaque payloads, required handlers, fresh actions, refusals and native Buffer independence passed.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
