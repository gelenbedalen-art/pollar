import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defineRampAdapter,
  RampAdapterClient,
  RampAdapterError,
  type RampAdapter,
  type RampAdapterCapabilities,
  type RampAdapterCreateRequest,
  type RampAdapterObservation,
  type RampAdapterOffer,
  type RampAdapterRoute,
  type RampAdapterUserContext,
} from '../src/ramps/index';

const user: RampAdapterUserContext = {
  applicationId: 'app-a',
  sdkUserId: 'user-a',
  providerId: 'provider-a',
  configurationId: 'account-a:testnet:v1',
  wallet: { address: 'wallet-a', chain: 'STELLAR', network: 'testnet', custody: 'external' },
};
const route: RampAdapterRoute = {
  routeId: 'deposit',
  direction: 'onramp',
  country: 'BO',
  fiatCurrency: 'BOB',
  rail: 'CUSTOM_QR',
  asset: { code: 'TOKEN', identifier: 'issuer-a', chain: 'STELLAR', network: 'testnet', precision: 7 },
  limits: { denomination: 'fiat', min: '1', max: '9007199254740993.0000001' },
};
const offer: RampAdapterOffer = {
  providerQuoteRef: 'quote-a',
  providerExpiresAt: '2030-01-01T00:00:00Z',
  terms: {
    fiatCurrency: 'BOB',
    fiatAmount: '10.0000001',
    cryptoAmount: '1.0000001',
    feeAmount: '0.0000001',
    feeCurrency: 'BOB',
    assetCode: 'TOKEN',
    assetChain: 'STELLAR',
    assetIssuer: 'issuer-a',
  },
  requiredFields: [],
  availableAmount: null,
};
const observation: RampAdapterObservation = {
  providerOrderRef: 'order-a',
  identity: 'order-a:revision-1',
  rawStatus: 'paid',
  facts: [{ kind: 'chain_transaction_reported', chain: 'STELLAR', hash: 'reported-only', leg: 'destination' }],
  proposedActions: [{ kind: 'wait', reason: 'settlement_verification' }],
  verificationRequired: false,
  payment: null,
};
const operation = { operationId: 'create-a', idempotencyKey: 'stable-key-a', transactionId: 'tx-a', providerOrderRef: null };
function fixture() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const capabilities: RampAdapterCapabilities = {
    routes: [structuredClone(route)],
    callbacks: false,
    polling: true,
    providerIdempotency: true,
    operationLookup: true,
    fiatPayoutEvidence: false,
    keyRetentionSeconds: null,
  };
  class Provider implements RampAdapter {
    readonly adapterId = 'local-provider';
    private readonly marker = 'bound-class';
    async capabilities() {
      assert.equal(this.marker, 'bound-class');
      return capabilities;
    }
    async quote(input: Parameters<RampAdapter['quote']>[0]) {
      calls.push({ method: 'quote', input });
      return structuredClone(offer);
    }
    async create(input: RampAdapterCreateRequest) {
      calls.push({ method: 'create', input });
      return { outcome: 'accepted' as const, observation: structuredClone(observation) };
    }
    async status(input: Parameters<RampAdapter['status']>[0]) {
      calls.push({ method: 'status', input });
      return structuredClone(observation);
    }
    async reconcile(input: Parameters<RampAdapter['reconcile']>[0]) {
      calls.push({ method: 'reconcile', input });
      return structuredClone(observation);
    }
  }
  const adapter: RampAdapter = defineRampAdapter(new Provider());
  const client = new RampAdapterClient([adapter], () => Date.parse('2026-10-20T00:00:00Z'));
  const input = { route: structuredClone(route), offer: structuredClone(offer), user, operation, payee: { bank: 'selected' } };
  return { client, adapter, input, calls, capabilities };
}
const code = (expected: string) => (error: unknown) => error instanceof RampAdapterError && error.code === expected;

test('standalone extension executes both directions with bound class methods and stable operation identities', async () => {
  const { client, input, calls, capabilities } = fixture();
  for (const direction of ['onramp', 'offramp'] as const) {
    input.route.direction = direction;
    capabilities.routes[0]!.direction = direction;
    const [discovered] = await client.getRoutes('local-provider', user);
    assert.equal(discovered!.direction, direction);
    const quoted = await client.quote('local-provider', {
      route: discovered!,
      user,
      amount: { value: '10.0000001', denomination: 'fiat' },
    });
    assert.equal(quoted.terms.fiatAmount, '10.0000001');
    const created = await client.create('local-provider', { ...input, offer: quoted });
    assert.equal(created.outcome, 'accepted');
    assert.equal(await client.prepare('local-provider', input), null);
    assert.equal(
      (await client.getStatus('local-provider', { user, providerOrderRef: 'order-a' })).identity,
      observation.identity,
    );
    assert.equal((await client.reconcile('local-provider', { user, operation }))!.identity, observation.identity);
  }
  assert.equal(calls.filter((call) => call.method === 'create').length, 2);
  const submitted = calls.find((call) => call.method === 'create')!.input as RampAdapterCreateRequest;
  assert.equal(submitted.operation, operation);
  assert.equal(submitted.payee, input.payee);
  assert.equal(submitted.user.configurationId, user.configurationId);
  assert.equal('lifecycleState' in observation, false); // A reported hash does not become completion.
});

test('registrations are instance-scoped, reject duplicates and cleanup cannot remove a replacement', async () => {
  const { adapter } = fixture();
  const client = new RampAdapterClient();
  const remove = client.register(adapter);
  assert.throws(() => client.register(adapter), code('AUTH_CONFIGURATION_ERROR'));
  assert.equal(new RampAdapterClient().has(adapter.adapterId), false);
  remove();
  const replacement = {
    ...adapter,
    capabilities: adapter.capabilities.bind(adapter),
    quote: adapter.quote.bind(adapter),
    create: adapter.create.bind(adapter),
    status: adapter.status.bind(adapter),
    reconcile: adapter.reconcile.bind(adapter),
  };
  client.register(replacement);
  remove();
  assert.equal(client.has(adapter.adapterId), true);
  client.clear();
  await assert.rejects(client.getRoutes(adapter.adapterId, user), code('UNSUPPORTED_ROUTE'));
  const stale = client.register(adapter);
  client.clear();
  client.register(adapter);
  stale();
  assert.equal(client.has(adapter.adapterId), true);
  assert.throws(() => defineRampAdapter({ adapterId: 'incomplete' } as RampAdapter), code('INVALID_INPUT'));
});

test('all supported chains use declared precision and reject an unknown chain', async () => {
  for (const chain of ['STELLAR', 'POLYGON', 'SOLANA'] as const) {
    const { client, adapter, capabilities } = fixture();
    const selected = structuredClone(route);
    selected.asset.chain = chain;
    selected.asset.precision = chain === 'STELLAR' ? 7 : 12;
    capabilities.routes = [selected];
    const context = { ...user, wallet: { ...user.wallet, chain } };
    adapter.quote = async () => ({ ...offer, terms: { ...offer.terms, assetChain: chain } });
    assert.equal(
      (
        await client.quote(adapter.adapterId, {
          route: selected,
          user: context,
          amount: { value: '10.0000001', denomination: 'fiat' },
        })
      ).terms.assetChain,
      chain,
    );
  }
  const { client, capabilities } = fixture();
  capabilities.routes[0]!.asset.chain = 'UNKNOWN' as RampAdapterRoute['asset']['chain'];
  await assert.rejects(client.getRoutes('local-provider', user), code('INVALID_INPUT'));
});

test('required payee fields and select values are checked before creating an order', async () => {
  const { client, input, calls } = fixture();
  input.offer.requiredFields = [
    { key: 'bank', label: 'Bank', type: 'select', options: [{ value: 'selected', label: 'Selected bank' }] },
  ];
  await assert.rejects(client.create('local-provider', { ...input, payee: {} }), code('INVALID_INPUT'));
  await assert.rejects(client.create('local-provider', { ...input, payee: { bank: 'other' } }), code('INVALID_INPUT'));
  assert.equal(calls.length, 0);
  assert.equal((await client.create('local-provider', input)).outcome, 'accepted');
});

test('route discovery returns detached configuration snapshots', async () => {
  const { client, capabilities, calls } = fixture();
  const [selected] = await client.getRoutes('local-provider', user);
  selected!.asset.network = 'mainnet';
  selected!.limits.min = '0';
  assert.equal(capabilities.routes[0]!.asset.network, 'testnet');
  assert.equal(capabilities.routes[0]!.limits.min, '1');
  await assert.rejects(
    client.quote('local-provider', { route: selected!, user, amount: { value: '10.0000001', denomination: 'fiat' } }),
    code('UNSUPPORTED_ROUTE'),
  );
  assert.equal(calls.length, 0);
});

test('invalid and unsupported routes, wallet networks, assets and changed limits never reach quote or create', async () => {
  const changes: Array<(input: RampAdapterCreateRequest) => void> = [
    (input) => {
      input.route.routeId = 'unknown';
    },
    (input) => {
      input.route.asset.chain = 'SOLANA';
    },
    (input) => {
      input.route.asset.network = 'mainnet';
    },
    (input) => {
      input.route.asset.identifier = 'other-issuer';
    },
    (input) => {
      input.route.asset.precision = 9;
    },
    (input) => {
      input.route.rail = 'OTHER';
    },
    (input) => {
      input.route.direction = 'offramp';
    },
    (input) => {
      input.route.limits.min = '0';
    },
    (input) => {
      input.user = { ...user, wallet: { ...user.wallet, network: 'mainnet' } };
    },
  ];
  for (const change of changes) {
    const { client, input, calls } = fixture();
    change(input);
    await assert.rejects(client.create('local-provider', input), code('UNSUPPORTED_ROUTE'));
    assert.equal(calls.length, 0);
  }
});

test('amounts remain exact beyond Number precision; limits compare all decimal digits', async () => {
  const { client, adapter, capabilities, calls } = fixture();
  const amount = '9007199254740993.0000001';
  adapter.quote = async (input) => {
    calls.push({ method: 'quote', input });
    return { ...offer, terms: { ...offer.terms, fiatAmount: input.amount.value } };
  };
  assert.equal(
    (await client.quote(adapter.adapterId, { route, user, amount: { value: amount, denomination: 'fiat' } })).terms.fiatAmount,
    amount,
  );
  await assert.rejects(
    client.quote(adapter.adapterId, { route, user, amount: { value: '9007199254740993.0000002', denomination: 'fiat' } }),
    code('INVALID_INPUT'),
  );
  assert.equal(calls.length, 1);
  capabilities.routes[0]!.limits.max = null;
});

test('negative, zero, exponential, whitespace and malformed decimal requests are rejected before dispatch', async () => {
  for (const value of ['0', '0.00', '-1', '1e2', 'NaN', '01', '1.', '1\n', ' 1', '1,00', '1'.repeat(1001)]) {
    const { client, calls } = fixture();
    await assert.rejects(
      client.quote('local-provider', { route, user, amount: { value, denomination: 'fiat' } }),
      code('INVALID_INPUT'),
    );
    assert.equal(calls.length, 0);
  }
});

test('quote and create reject wrong terms, precision, expiry and changed requested amounts', async () => {
  for (const terms of [
    { ...offer.terms, assetChain: 'SOLANA' as const },
    { ...offer.terms, assetIssuer: 'other' },
    { ...offer.terms, fiatCurrency: 'USD' },
    { ...offer.terms, cryptoAmount: '1.00000001' },
    { ...offer.terms, feeAmount: '-1' },
  ]) {
    const { client, adapter, input, calls } = fixture();
    adapter.quote = async () => ({ ...offer, terms });
    await assert.rejects(
      client.quote(adapter.adapterId, { route, user, amount: { value: '10.0000001', denomination: 'fiat' } }),
      code('INVALID_INPUT'),
    );
    input.offer.terms = terms;
    await assert.rejects(client.create(adapter.adapterId, input), code('INVALID_INPUT'));
    assert.equal(calls.length, 0);
  }
  const { client, input, calls } = fixture();
  await assert.rejects(
    client.quote('local-provider', { route, user, amount: { value: '11', denomination: 'fiat' } }),
    code('QUOTE_CHANGED'),
  );
  input.offer.providerExpiresAt = '2026-10-19T00:00:00Z';
  await assert.rejects(client.create('local-provider', input), code('QUOTE_EXPIRED'));
  input.offer.providerExpiresAt = 'invalid';
  await assert.rejects(client.create('local-provider', input), code('QUOTE_EXPIRED'));
  assert.equal(calls.filter((call) => call.method === 'create').length, 0);
});

test('unknown or malformed write results are redacted, returned once and reconciled without another create', async () => {
  const { client, adapter, input, calls } = fixture();
  adapter.create = async (request) => {
    calls.push({ method: 'create', input: request });
    throw new Error('provider-secret-must-not-escape');
  };
  const result = await client.create(adapter.adapterId, input);
  assert.equal(result.outcome, 'unknown');
  if (result.outcome !== 'unknown') throw new Error('Expected unknown');
  assert.equal(result.error.recovery, 'reconcile');
  assert.equal(result.error.message.includes('secret'), false);
  await client.reconcile(adapter.adapterId, { operation, user });
  assert.equal(calls.filter((call) => call.method === 'create').length, 1);
  adapter.create = async () => undefined as unknown as Awaited<ReturnType<RampAdapter['create']>>;
  assert.equal((await client.create(adapter.adapterId, input)).outcome, 'unknown');
});

test('provider rejection and unknown references remain distinguishable', async () => {
  const { client, adapter, input } = fixture();
  adapter.create = async () => ({ outcome: 'rejected', error: new RampAdapterError('PROVIDER_REJECTED', 'correct_input') });
  assert.equal((await client.create(adapter.adapterId, input)).outcome, 'rejected');
  adapter.create = async () => ({
    outcome: 'unknown',
    error: new RampAdapterError('OUTCOME_UNKNOWN', 'reconcile'),
    providerOrderRef: 'maybe-created',
  });
  const result = await client.create(adapter.adapterId, input);
  assert.equal(result.outcome === 'unknown' && result.providerOrderRef, 'maybe-created');
});

test('malformed observations become unknown after dispatch and wrong order references are rejected on reads', async () => {
  const { client, adapter, input } = fixture();
  adapter.create = async () => ({ outcome: 'accepted', observation: { identity: 'incomplete' } as RampAdapterObservation });
  assert.equal((await client.create(adapter.adapterId, input)).outcome, 'unknown');
  adapter.status = async () => ({ ...observation, providerOrderRef: 'another-customer-order' });
  await assert.rejects(client.getStatus(adapter.adapterId, { user, providerOrderRef: 'order-a' }), code('INVALID_INPUT'));
  adapter.reconcile = async () => ({ ...observation, providerOrderRef: 'another-customer-order' });
  await assert.rejects(
    client.reconcile(adapter.adapterId, { user, operation: { ...operation, providerOrderRef: 'order-a' } }),
    code('INVALID_INPUT'),
  );
});

test('capability declarations require implementations and route identities must be unique', async () => {
  for (const change of [
    (caps: RampAdapterCapabilities) => {
      caps.callbacks = true;
    },
    (caps: RampAdapterCapabilities) => {
      caps.refunds = 'api';
    },
    (caps: RampAdapterCapabilities) => {
      caps.continuations = ['signed_payload'];
    },
    (caps: RampAdapterCapabilities) => {
      caps.routes.push(structuredClone(route));
    },
  ]) {
    const { client, capabilities } = fixture();
    change(capabilities);
    await assert.rejects(client.getCapabilities('local-provider', user), code('AUTH_CONFIGURATION_ERROR'));
  }
});

test('continuations preserve bound action IDs and pass only explicit signed payloads', async () => {
  const { client, adapter, capabilities } = fixture();
  capabilities.continuations = ['signed_payload'];
  const received: unknown[] = [];
  adapter.continue = async (input) => {
    received.push(input);
    return { outcome: 'accepted', observation };
  };
  const input = {
    user,
    operation,
    action: {
      kind: 'sign_transaction' as const,
      actionId: 'saved-action',
      purpose: 'withdrawal_payment' as const,
      chain: 'STELLAR' as const,
      network: 'testnet',
      challengeRef: 'saved-challenge',
      payload: { encoding: 'xdr', value: 'unsigned' },
      expiresAt: '2030-01-01T00:00:00Z',
    },
  };
  await assert.rejects(client.continue(adapter.adapterId, input), code('INVALID_INPUT'));
  await client.continue(adapter.adapterId, { ...input, signedPayload: 'signed' });
  assert.equal(received.length, 1);
  assert.equal((received[0] as { action: { actionId: string } }).action.actionId, 'saved-action');
  await assert.rejects(
    client.continue(adapter.adapterId, {
      ...input,
      signedPayload: 'signed',
      action: { ...input.action, expiresAt: '2000-01-01T00:00:00Z' },
    }),
    code('QUOTE_EXPIRED'),
  );
  assert.equal(received.length, 1);
});

test('callbacks go through the provider verifier with original raw bytes; refunds need authorization and capability', async () => {
  const { client, adapter, capabilities } = fixture();
  const rawBody = new TextEncoder().encode('{"event":"paid"}');
  await assert.rejects(
    client.verifyAndNormalizeCallback(adapter.adapterId, { user, rawBody, headers: {} }),
    code('UNSUPPORTED_ROUTE'),
  );
  capabilities.callbacks = true;
  adapter.verifyAndNormalizeCallback = async (input) => {
    assert.equal(input.rawBody, rawBody);
    if (input.headers.signature !== 'verified-fixture') throw new RampAdapterError('INVALID_INPUT', 'operator');
    return observation;
  };
  await assert.rejects(
    client.verifyAndNormalizeCallback(adapter.adapterId, { user, rawBody, headers: {} }),
    code('INVALID_INPUT'),
  );
  assert.equal(
    (await client.verifyAndNormalizeCallback(adapter.adapterId, { user, rawBody, headers: { signature: 'verified-fixture' } }))
      .identity,
    observation.identity,
  );
  let refunds = 0;
  adapter.refund = async () => {
    refunds++;
    return { outcome: 'accepted', observation };
  };
  const refund = { user, operation, authorizationRef: 'approved-by-operator', amount: '1.0000001', currency: 'BOB' };
  await assert.rejects(client.refund(adapter.adapterId, refund), code('UNSUPPORTED_ROUTE'));
  capabilities.refunds = 'api';
  await assert.rejects(client.refund(adapter.adapterId, { ...refund, authorizationRef: '' }), code('INVALID_INPUT'));
  await client.refund(adapter.adapterId, refund);
  assert.equal(refunds, 1);
});
