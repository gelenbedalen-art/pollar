// @pollar smoke test - the React RampWidget on the v3 ramp API: route choice,
// quotes, the fields a quote asks for, the order's progress and its pending
// action, resuming a pending order, and an app out of credits.
//
// Run with `node tests/smoke-ramp-widget.cjs` after `npm run build`.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<html><body></body></html>', { url: 'https://demo.test/' });
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'Event',
  'localStorage',
  'sessionStorage',
])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response(JSON.stringify({ success: true, content: {} }));
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { PollarClient, PollarApiError } = require('../packages/core/dist/index.js');
const { PollarProvider, RampWidget } = require('../packages/react/dist/index.js');
const h = React.createElement;

const later = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const bob = { kind: 'fiat', currency: 'BOB', rail: 'QR', country: 'BO' };
const usdc = { kind: 'asset', code: 'USDC', identifier: 'GA5Z', chain: 'STELLAR' };
const quote = {
  quoteId: 'q1',
  expiresAt: later(60),
  amountIn: '100',
  amountOut: '14.2',
  etaSeconds: 300,
  legs: [
    {
      index: 0,
      kind: 'PROVIDER_ONRAMP',
      from: bob,
      to: usdc,
      amountIn: '100',
      amountOut: '14.2',
      providerFees: [],
      fees: [],
      etaSeconds: 300,
      expiresAt: null,
      wallet: null,
      requiredFields: [{ key: 'name', label: 'Full name', type: 'text' }],
    },
  ],
};
const order = (pendingAction, patch = {}) => ({
  id: 'order-0001',
  direction: 'ONRAMP',
  state: 'awaiting_payment',
  createdAt: later(0),
  updatedAt: later(0),
  legs: [
    {
      index: 0,
      kind: 'PROVIDER_ONRAMP',
      status: 'AWAITING_ACTION',
      from: bob,
      to: usdc,
      amountInPlanned: '100',
      amountOutPlanned: '14.2',
      amountInActual: null,
      amountOutActual: null,
      onchainTxHash: null,
      signingMode: null,
      fundsLocation: null,
      failure: null,
    },
  ],
  pendingAction,
  failure: null,
  nextPollAfter: later(5),
  ...patch,
});
const qrAction = {
  kind: 'FIAT_PAYMENT',
  actionId: 'pay',
  legIndex: 0,
  expiresAt: null,
  instructions: {
    kind: 'qr',
    payload: '000201fixture',
    amount: '100',
    currency: 'BOB',
    scannable: {
      kind: 'opaque',
      payload: '000201fixture',
      payloadLabel: 'Payment code',
      image: { mediaType: 'image/svg+xml', encoding: 'utf8', data: '<svg id="fixture-qr"></svg>', inlineSafe: true },
    },
  },
};
// A real payment from the user's account: the widget reads its source before the wallet is asked.
const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = require('@stellar/stellar-sdk');
const userKey = Keypair.random();
const paymentFrom = (address) =>
  new TransactionBuilder(new Account(address, '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(300)
    .build()
    .toXDR();
const unsignedXdr = paymentFrom(userKey.publicKey());
const signAction = {
  kind: 'SIGNATURE',
  actionId: 'sign',
  legIndex: 0,
  chain: 'STELLAR',
  payload: { encoding: 'xdr', value: unsignedXdr },
  summary: 'payment',
  expiresAt: later(60),
};

function fixtureClient(overrides = {}) {
  const client = new PollarClient({ apiKey: 'pub_mainnet_fixture', baseUrl: 'https://api.test', logLevel: 'silent' });
  const wallet = { address: userKey.publicKey(), network: 'STELLAR' };
  client.getNetworkState = () => ({ step: 'connected', network: 'mainnet' });
  client.onNetworkStateChange = (cb) => {
    cb(client.getNetworkState());
    return () => {};
  };
  client.getWallet = () => wallet;
  client.getWallets = () => [wallet];
  const calls = [];
  Object.assign(client, {
    getRampRoutes: async (direction) => {
      calls.push(['getRampRoutes', direction]);
      return { routes: [{ fiat: bob, asset: usdc, legs: ['PROVIDER_ONRAMP'] }] };
    },
    listRampOrders: async () => ({ orders: [], nextCursor: null }),
    quoteRamp: async (body) => {
      calls.push(['quoteRamp', body]);
      return { quotes: [quote], rejected: [] };
    },
    createRampOrder: async (body) => {
      calls.push(['createRampOrder', body]);
      return order(qrAction);
    },
    getRampOrder: async (id) => {
      calls.push(['getRampOrder', id]);
      return order(signAction);
    },
    pollRampOrder: async () => new Promise(() => {}),
    // As core does: the signer registered for the action's chain and encoding signs it.
    signRampLeg: async (id, actionId) => {
      const signer = client._rampSigners.resolve('STELLAR', 'xdr');
      if (!signer) throw new Error('Register a ramp signing handler for STELLAR/xdr.');
      calls.push(['signRampLeg', id, actionId, await signer(signAction)]);
      return order(null, { state: 'processing' });
    },
    signTx: async (xdr) => {
      calls.push(['signTx', xdr]);
      return { status: 'signed', signedXdr: `wallet-signed:${xdr}` };
    },
    ...overrides,
  });
  return { client, calls };
}

async function mount(client, application = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(
        PollarProvider,
        {
          client,
          appConfig: { application: { name: 'Fixture', network: 'mainnet', chains: ['STELLAR'], ...application }, styles: {} },
        },
        h(RampWidget, { onClose() {} }),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  const button = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
  const click = async (element) => {
    assert.ok(element, 'missing element');
    await act(async () => {
      element.click();
      await new Promise((r) => setTimeout(r, 10));
    });
  };
  const type = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, button, click, type, unmount };
}

(async () => {
  // --- Route, quote, details, order, payment, signature ---
  {
    const { client, calls } = fixtureClient();
    const ui = await mount(client);
    assert.deepEqual(calls[0], ['getRampRoutes', 'ONRAMP']);
    assert.match(ui.container.textContent, /USDC on Stellar/);
    await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
    await ui.click(ui.button('Find best route'));
    assert.deepEqual(calls[1], [
      'quoteRamp',
      {
        direction: 'ONRAMP',
        fiat: { currency: 'BOB', rail: 'QR', country: 'BO' },
        asset: { code: 'USDC', identifier: 'GA5Z', chain: 'STELLAR' },
        amount: { value: '100', denomination: 'in' },
      },
    ]);
    assert.match(ui.container.textContent, /100 BOB → 14.2 USDC/);
    await ui.click(ui.container.querySelector('.pollar-ramp-route-card'));
    assert.match(ui.container.textContent, /Full name/, 'a quote that asks for fields opens the details step');
    assert.equal(calls.length, 2, 'no order before the details are in');
    await ui.type(ui.container.querySelector('.pollar-ramp-input'), ' Ana Perez ');
    await ui.click(ui.button('Continue'));
    assert.deepEqual(calls[2], ['createRampOrder', { quoteId: 'q1', payee: { name: 'Ana Perez' } }]);
    assert.ok(ui.container.querySelector('#fixture-qr'), 'the rendered QR is shown');
    assert.match(ui.container.textContent, /Pay 100 BOB/);
    assert.match(ui.container.textContent, /000201fixture/);
    assert.equal(ui.button('Authorize'), undefined, 'nothing to sign while the action is a payment');
    // The refresh reads the order again: now it waits on a signature.
    await ui.click(ui.container.querySelector('[aria-label="Refresh"]'));
    assert.deepEqual(calls.at(-1), ['getRampOrder', 'order-0001']);
    assert.equal(calls.filter(([name]) => name === 'signRampLeg').length, 0, 'never sign before the user clicks');
    await ui.click(ui.button('Authorize'));
    assert.deepEqual(calls.slice(-2), [
      ['signTx', unsignedXdr],
      ['signRampLeg', 'order-0001', 'sign', `wallet-signed:${unsignedXdr}`],
    ]);
    assert.equal(client._rampSigners.resolve('STELLAR', 'xdr'), undefined, 'the widget releases the signer it lent');
    await ui.unmount();
    client.destroy();
  }

  // --- A Stellar step built for another account never reaches the wallet ---
  {
    const foreign = { ...signAction, payload: { encoding: 'xdr', value: paymentFrom(Keypair.random().publicKey()) } };
    const { client, calls } = fixtureClient({
      listRampOrders: async () => ({ orders: [order(foreign)], nextCursor: null }),
      getRampOrder: async () => order(foreign),
      signRampLeg: async (id, actionId) => {
        calls.push(['signRampLeg', id, actionId, await client._rampSigners.resolve('STELLAR', 'xdr')(foreign)]);
        return order(null, { state: 'processing' });
      },
    });
    const ui = await mount(client);
    await ui.click(ui.button('Resume purchase'));
    await ui.click(ui.button('Authorize'));
    assert.equal(calls.filter(([name]) => name === 'signTx').length, 0, 'Freighter is never asked');
    assert.match(ui.container.textContent, /not for the connected Stellar account/);
    await ui.unmount();
    client.destroy();
  }

  // --- The wallet switched accounts while it was signing: the signature is not sent ---
  {
    const { client, calls } = fixtureClient({
      listRampOrders: async () => ({ orders: [order(signAction)], nextCursor: null }),
    });
    client.signTx = async () => {
      client.getWallet = () => ({ address: Keypair.random().publicKey(), network: 'STELLAR' });
      return { status: 'signed', signedXdr: 'signed-by-the-other-account' };
    };
    const ui = await mount(client);
    await ui.click(ui.button('Resume purchase'));
    await ui.click(ui.button('Authorize'));
    assert.equal(calls.filter(([name]) => name === 'signRampLeg').length, 0);
    assert.match(ui.container.textContent, /connected wallet changed/);
    await ui.unmount();
    client.destroy();
  }

  // --- An app with its own Stellar signer keeps it ---
  {
    const { client, calls } = fixtureClient({
      listRampOrders: async () => ({ orders: [order(signAction)], nextCursor: null }),
    });
    const own = client.registerRampSigningHandler('STELLAR', 'xdr', async () => 'app-signed');
    const ui = await mount(client);
    await ui.click(ui.button('Resume purchase'));
    await ui.click(ui.button('Authorize'));
    assert.deepEqual(calls.at(-1), ['signRampLeg', 'order-0001', 'sign', 'app-signed']);
    assert.equal(calls.filter(([name]) => name === 'signTx').length, 0);
    assert.ok(client._rampSigners.resolve('STELLAR', 'xdr'), "the app's signer stays registered");
    own();
    await ui.unmount();
    client.destroy();
  }

  // --- An external Solana wallet signs its own leg; a leg built for another wallet is refused ---
  for (const from of ['So1User', 'So1Someone']) {
    const solanaAction = {
      ...signAction,
      chain: 'SOLANA',
      payload: { encoding: 'solana-v0-json', value: JSON.stringify({ from, unsignedTransaction: 'AAEC' }) },
    };
    const { client, calls } = fixtureClient({
      listRampOrders: async () => ({ orders: [order(solanaAction)], nextCursor: null }),
      getRampOrder: async () => order(solanaAction),
      signRampLeg: async (id, actionId) => {
        const signer = client._rampSigners.resolve('SOLANA', 'solana-v0-json');
        if (!signer) throw new Error('Register a ramp signing handler for SOLANA/solana-v0-json.');
        calls.push(['signRampLeg', id, actionId, await signer(solanaAction)]);
        return order(null, { state: 'processing' });
      },
      signSolanaTransaction: async (tx) => {
        calls.push(['signSolanaTransaction', tx]);
        return `wallet-signed:${tx}`;
      },
    });
    client.getWallets = () => [
      { address: userKey.publicKey(), network: 'STELLAR', chain: 'STELLAR' },
      { address: 'So1User', chain: 'SOLANA', custody: 'external' },
    ];
    const ui = await mount(client);
    await ui.click(ui.button('Resume purchase'));
    await ui.click(ui.button('Authorize'));
    if (from === 'So1User')
      assert.deepEqual(calls.slice(-2), [
        ['signSolanaTransaction', 'AAEC'],
        ['signRampLeg', 'order-0001', 'sign', 'wallet-signed:AAEC'],
      ]);
    else {
      assert.equal(calls.filter(([name]) => name === 'signSolanaTransaction').length, 0);
      assert.match(ui.container.textContent, /signed by the Solana wallet it was built for/);
    }
    assert.equal(client._rampSigners.resolve('SOLANA', 'solana-v0-json'), undefined);
    await ui.unmount();
    client.destroy();
  }

  // --- A pending order is resumed from the start screen ---
  {
    const { client, calls } = fixtureClient({
      listRampOrders: async () => ({ orders: [order(signAction)], nextCursor: null }),
    });
    const ui = await mount(client);
    await ui.click(ui.button('Resume purchase'));
    assert.deepEqual(calls.at(-1), ['getRampOrder', 'order-0001']);
    assert.ok(ui.button('Authorize'));
    await ui.unmount();
    client.destroy();
  }

  // --- A route waiting on a verification step opens the step from its button ---
  {
    const registration = {
      position: 1,
      completed: 0,
      total: 1,
      type: 'PROVIDER_REGISTRATION',
      optionId: 'stereum',
      status: 'none',
      corridorId: 'corridor-bob-usdc',
    };
    const locked = {
      legs: [{ index: 0, kind: 'PROVIDER_ONRAMP', from: bob, to: usdc }],
      failure: {
        code: 'PROVIDER_VERIFICATION_REQUIRED',
        legIndex: 0,
        retryable: false,
        resolutionOwner: 'END_USER',
        resolutionAction: 'complete_verification',
      },
      requirement: registration,
    };
    const { client, calls } = fixtureClient({
      quoteRamp: async (body) => {
        calls.push(['quoteRamp', body]);
        throw new PollarApiError('SDK_RAMPS_NO_ROUTE', { code: 'SDK_RAMPS_NO_ROUTE', rejected: [locked] });
      },
      getProviderRegistration: async (corridorId) => {
        calls.push(['getProviderRegistration', corridorId]);
        return { status: 'none', fields: [] };
      },
    });
    const ui = await mount(client);
    await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
    await ui.click(ui.button('Find best route'));
    assert.match(ui.container.textContent, /Register with the provider to see this route/);
    await ui.click(ui.button('Continue'));
    assert.deepEqual(calls.at(-1), ['getProviderRegistration', 'corridor-bob-usdc']);
    assert.equal(ui.container.querySelector('.pollar-ramp-route-card'), null, 'the step replaces the widget');
    // Closing the step returns to the routes as they were.
    await ui.click(ui.container.querySelector('.pollar-modal-close'));
    assert.match(ui.container.textContent, /Register with the provider to see this route/);
    assert.equal(calls.filter(([name]) => name === 'quoteRamp').length, 1, 'closing does not quote again');
    await ui.unmount();
    client.destroy();
  }

  // --- A route dropped for a missing trustline adds it from its row and quotes again ---
  {
    const untrusted = {
      legs: [{ index: 0, kind: 'PROVIDER_ONRAMP', from: bob, to: usdc }],
      failure: {
        code: 'WALLET_TRUSTLINE_MISSING',
        legIndex: 0,
        retryable: false,
        resolutionOwner: 'END_USER',
        resolutionAction: 'add_trustline',
      },
    };
    let trusted = false;
    let release;
    const { client, calls } = fixtureClient({
      quoteRamp: async (body) => {
        calls.push(['quoteRamp', body]);
        if (trusted) return { quotes: [quote], rejected: [] };
        throw new PollarApiError('SDK_RAMPS_NO_ROUTE', { code: 'SDK_RAMPS_NO_ROUTE', rejected: [untrusted] });
      },
      setTrustline: (asset) => {
        calls.push(['setTrustline', asset]);
        return new Promise((resolve) => {
          release = () => {
            trusted = true;
            resolve({ status: 'success', hash: 'trust-hash' });
          };
        });
      },
      refreshAssets: async () => {},
    });
    const ui = await mount(client);
    await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
    await ui.click(ui.button('Find best route'));
    await ui.click(ui.button('Add USDC trustline'));
    assert.deepEqual(calls.at(-1), ['setTrustline', { code: 'USDC', issuer: 'GA5Z' }]);
    const adding = ui.button('Adding');
    assert.ok(adding && adding.disabled, 'the button spins and stays disabled while the trustline is added');
    await ui.click(adding);
    assert.equal(calls.filter(([name]) => name === 'setTrustline').length, 1, 'a second click adds nothing');
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(calls.filter(([name]) => name === 'quoteRamp').length, 2, 'quoted again once trusted');
    assert.match(ui.container.textContent, /100 BOB → 14.2 USDC/);
    await ui.unmount();
    client.destroy();
  }

  // --- A trustline the wallet cannot pay for says so in words, never with the raw detail ---
  {
    const untrusted = {
      legs: [{ index: 0, kind: 'PROVIDER_ONRAMP', from: bob, to: usdc }],
      failure: {
        code: 'WALLET_TRUSTLINE_MISSING',
        legIndex: 0,
        retryable: false,
        resolutionOwner: 'END_USER',
        resolutionAction: 'add_trustline',
      },
    };
    const { client } = fixtureClient({
      quoteRamp: async () => {
        throw new PollarApiError('SDK_RAMPS_NO_ROUTE', { code: 'SDK_RAMPS_NO_ROUTE', rejected: [untrusted] });
      },
      setTrustline: async () => ({
        status: 'error',
        code: 'TX_LOW_RESERVE',
        details: 'Insufficient XLM: fund GBQSHLR3BE3WOB7KL4YYAKDTTIOLONDDOEGL3B2TAAXDCLKZUTZN4JTT with about 0.5 more XLM',
      }),
    });
    const ui = await mount(client);
    await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
    await ui.click(ui.button('Find best route'));
    await ui.click(ui.button('Add USDC trustline'));
    assert.match(ui.container.textContent, /needs about 0.5 XLM to add the USDC trustline/);
    assert.doesNotMatch(ui.container.textContent, /GBQSHLR3/, 'no address in the message');
    await ui.unmount();
    client.destroy();
  }

  // --- A user without a wallet creates it from the route's row, and the route is quoted again ---
  {
    const walletless = {
      legs: [{ index: 0, kind: 'PROVIDER_ONRAMP', from: bob, to: usdc }],
      failure: {
        code: 'WALLET_NOT_CREATED',
        legIndex: 0,
        retryable: false,
        resolutionOwner: 'END_USER',
        resolutionAction: 'create_wallet',
      },
    };
    for (const custody of ['COSIGNED', 'USER_CHOICE']) {
      let created = false;
      let release;
      const { client, calls } = fixtureClient({
        quoteRamp: async (body) => {
          calls.push(['quoteRamp', body]);
          if (created) return { quotes: [quote], rejected: [] };
          throw new PollarApiError('SDK_RAMPS_NO_ROUTE', { code: 'SDK_RAMPS_NO_ROUTE', rejected: [walletless] });
        },
        createWallet: () => {
          calls.push(['createWallet']);
          return new Promise((resolve) => {
            release = () => {
              created = true;
              resolve({ address: userKey.publicKey(), chain: 'STELLAR' });
            };
          });
        },
      });
      const ui = await mount(client, { walletCustodyMode: custody });
      await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
      await ui.click(ui.button('Find best route'));
      if (custody === 'USER_CHOICE') {
        assert.equal(ui.button('Create wallet'), undefined, 'the custody is picked in the wallet menu');
        assert.match(ui.container.textContent, /Create it from the wallet menu/);
      } else {
        await ui.click(ui.button('Create wallet'));
        const creating = ui.button('Creating');
        assert.ok(creating && creating.disabled, 'the button spins and stays disabled while the wallet is created');
        await ui.click(creating);
        assert.equal(calls.filter(([name]) => name === 'createWallet').length, 1, 'a second click creates nothing');
        await act(async () => {
          release();
          await new Promise((r) => setTimeout(r, 20));
        });
        assert.equal(calls.filter(([name]) => name === 'quoteRamp').length, 2, 'quoted again once the wallet exists');
        assert.match(ui.container.textContent, /100 BOB → 14.2 USDC/);
      }
      await ui.unmount();
      client.destroy();
    }
  }

  // --- An app with no chain says so instead of an empty list ---
  {
    const { client } = fixtureClient({ getRampRoutes: async () => ({ routes: [] }) });
    const ui = await mount(client, { chains: [] });
    assert.match(ui.container.textContent, /no chains enabled/);
    await ui.unmount();
    client.destroy();
  }

  // --- An app out of credits: the user is pointed to the app, never told about credits ---
  {
    const { client } = fixtureClient({
      quoteRamp: async () => {
        throw new PollarApiError('SDK_CREDITS_INSUFFICIENT', { code: 'SDK_CREDITS_INSUFFICIENT' });
      },
    });
    const ui = await mount(client);
    await ui.type(ui.container.querySelector('#pollar-ramp-amount'), '100');
    await ui.click(ui.button('Find best route'));
    assert.match(ui.container.textContent, /contact this app's support/);
    assert.doesNotMatch(ui.container.textContent, /credit/i);
    await ui.unmount();
    client.destroy();
  }

  console.log(
    'Ramp widget v3: route, quote, details, order, QR, Stellar and Solana wallet signing, verification step, trustline, wallet creation, no chains, resume and 402 passed.',
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
