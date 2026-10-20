import { RampAdapterClient, type RampAdapterUserContext } from '@pollar/core/ramps';
import { createExampleRampAdapter, type ExampleProviderClient, type ExampleProviderOrder } from './adapter';

// Disposable simulation only: no HTTP requests, payments, credentials or durable storage.
const orders = new Map<string, ExampleProviderOrder>();
const keys = new Map<string, string>();
const provider: ExampleProviderClient = {
  async quote({ amount }) {
    return {
      reference: `quote:${amount}`,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      fiatAmount: amount,
      cryptoAmount: amount,
      feeAmount: '0',
    };
  },
  async createOrder(input) {
    const key = `${input.configurationId}:${input.idempotencyKey}`;
    const existing = keys.get(key);
    if (existing) return orders.get(existing)!;
    const order: ExampleProviderOrder = {
      reference: `order:${orders.size + 1}`,
      revision: '1',
      status: 'waiting_funds',
      direction: input.direction,
    };
    orders.set(order.reference, order);
    keys.set(key, order.reference);
    return order;
  },
  async getOrder(reference) {
    const order = orders.get(reference);
    if (!order) throw new Error('Order not found');
    return order;
  },
  async findOrder({ configurationId, idempotencyKey }) {
    return orders.get(keys.get(`${configurationId}:${idempotencyKey}`) ?? '') ?? null;
  },
};
const user: RampAdapterUserContext = {
  applicationId: 'demo-app',
  sdkUserId: 'demo-user',
  providerId: 'demo-provider',
  configurationId: 'demo-testnet-v1',
  wallet: { address: 'demo-wallet', chain: 'STELLAR', network: 'testnet', custody: 'external' },
};

export async function runDemo() {
  const ramps = new RampAdapterClient([createExampleRampAdapter(provider)]);
  for (const route of await ramps.getRoutes('example-bank', user)) {
    const offer = await ramps.quote('example-bank', { route, user, amount: { value: '10.0000001', denomination: 'fiat' } });
    const operation = {
      operationId: `op:${route.direction}`,
      idempotencyKey: `key:${route.direction}`,
      transactionId: `tx:${route.direction}`,
      providerOrderRef: null,
    };
    const result = await ramps.create('example-bank', { route, user, offer, operation, payee: {} });
    if (result.outcome !== 'accepted' || !result.observation.providerOrderRef) throw new Error('Unexpected outcome');
    const status = await ramps.getStatus('example-bank', { user, providerOrderRef: result.observation.providerOrderRef });
    const recovered = await ramps.reconcile('example-bank', { user, operation });
    if (status.providerOrderRef !== recovered?.providerOrderRef) throw new Error('Reconciliation mismatch');
    console.log(`${route.direction}: ${offer.terms.fiatAmount} -> ${status.rawStatus}; recovered same order`);
  }
}

void runDemo().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
