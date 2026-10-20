const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<html><body></body></html>', { url: 'https://demo.test/?rampTxId=saved-order' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage'])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response(JSON.stringify({ success: true, content: {} }));
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { PollarClient } = require('../packages/core/dist/index.js');
const { PollarProvider, RampWidget } = require('../packages/react/dist/index.js');
const h = React.createElement;
const base = {
  txId: 'saved-order',
  provider: 'Anclap',
  status: 'pending',
  direction: 'onramp',
  transactionVersion: 4,
  reconciliationRequired: false,
};
async function scenario(action, reconcile = false) {
  const client = new PollarClient({ apiKey: 'pub_mainnet_fixture', baseUrl: 'https://api.test/v2' });
  const wallet = { address: 'G-wallet', network: 'STELLAR' };
  client.getNetworkState = () => ({ step: 'connected', network: 'mainnet' });
  client.onNetworkStateChange = (cb) => {
    cb(client.getNetworkState());
    return () => {};
  };
  client.getWallet = () => wallet;
  client.getWallets = () => [wallet];
  client.getRampCountries = async () => ({ countries: [] });
  client.getRampTransaction = async () => ({ ...base, reconciliationRequired: reconcile, nextAction: action });
  let signs = 0;
  const calls = [];
  client.signTx = async () => {
    signs++;
    return { status: 'signed', signedXdr: 'signed-auth-xdr' };
  };
  client.submitRampSignature = async () => {
    throw new Error('Legacy signature endpoint must not be used');
  };
  client.submitTx = async () => {
    throw new Error('Authentication must not be broadcast');
  };
  client.registerRampSigningHandler('STELLAR', 'xdr', async () => {
    signs++;
    return 'signed-auth-xdr';
  });
  client.signTx = async () => {
    throw new Error('Core must use the registered ramp signer');
  };
  client.continueRamp = async (id, body) => {
    calls.push({ id, body });
    return {
      ...base,
      transactionVersion: 5,
      nextAction: {
        kind: 'hosted_redirect',
        actionId: 'hosted',
        purpose: 'verification',
        url: 'https://anchor.test/kyc',
        expiresAt: null,
      },
      kycRequired: true,
    };
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root = createRoot(container);
  const renderWidget = () =>
    h(
      PollarProvider,
      { client, appConfig: { application: { name: 'Fixture', network: 'mainnet', chains: ['STELLAR'] }, styles: {} } },
      h(RampWidget, { onClose() {} }),
    );
  await act(async () => {
    root.render(renderWidget());
    await new Promise((r) => setTimeout(r, 20));
  });
  const buttons = () => [...container.querySelectorAll('button')];
  const label = action.kind === 'sign_transaction' ? 'Authorize' : 'Continue';
  const button = buttons().find((b) => b.textContent === label);
  if (reconcile) {
    assert.equal(button, undefined);
    assert.match(container.textContent, /checking your transfer/);
  } else {
    assert.ok(button, `Missing ${label}`);
    assert.equal(calls.length, 0, 'Never dispatch an action before the user clicks');
    await act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.deepEqual(calls, [
      {
        id: 'saved-order',
        body: {
          actionId: action.actionId,
          transactionVersion: 4,
          ...(action.kind === 'sign_transaction' ? { signedPayload: 'signed-auth-xdr' } : {}),
        },
      },
    ]);
    assert.equal(signs, action.kind === 'sign_transaction' ? 1 : 0);
    assert.ok(!!container.querySelector('a[href="https://anchor.test/kyc"]'), 'Hosted KYC must be displayed');
  }
  const previousCalls = calls.length;
  const explore = buttons().find((b) => b.textContent === 'Try another route');
  assert.ok(explore, 'A pending workflow must let the user explore other routes');
  await act(async () => {
    explore.click();
  });
  assert.match(container.textContent, /pending operations are saved/);
  assert.ok(buttons().some((b) => b.textContent.startsWith('Resume Anclap')));
  assert.equal(calls.length, previousCalls, 'Exploring must not cancel, continue or create an order');
  assert.equal(signs, reconcile ? 0 : action.kind === 'sign_transaction' ? 1 : 0);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(renderWidget());
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.match(
    container.textContent,
    /pending operations are saved/,
    'Reopening must keep the route selection, even with rampTxId in the URL',
  );
  const resume = buttons().find((b) => b.textContent.startsWith('Resume Anclap'));
  assert.ok(resume);
  await act(async () => {
    resume.click();
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.match(container.textContent, /Complete your deposit/);
  assert.equal(calls.length, previousCalls, 'Resuming must only fetch status');
  const remove = buttons().find((button) => button.textContent === 'Remove from pending list');
  assert.ok(remove);
  await act(async () => remove.click());
  assert.match(container.textContent, /no payment was cancelled or refunded/);
  assert.ok(!buttons().some((button) => button.textContent.startsWith('Resume Anclap')));
  assert.equal(calls.length, previousCalls, 'Hiding a reference must not dispatch a provider cancellation');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(renderWidget());
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(!buttons().some((button) => button.textContent.startsWith('Resume Anclap')));
  assert.doesNotMatch(container.textContent, /Complete your deposit/);
  await act(async () => root.unmount());
  container.remove();
  client.destroy();
  sessionStorage.clear();
}
(async () => {
  await scenario({ kind: 'user_ready', purpose: 'create_order', actionId: 'create' });
  await scenario({
    kind: 'sign_transaction',
    purpose: 'authentication',
    actionId: 'auth',
    chain: 'STELLAR',
    network: 'mainnet',
    payload: { encoding: 'xdr', value: 'auth-xdr' },
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await scenario({ kind: 'user_ready', purpose: 'create_order', actionId: 'blocked' }, true);
  console.log(
    'Ramp widget: saved orders, exploring and resuming, explicit continuation, authentication, hosted KYC and reconciliation passed',
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
