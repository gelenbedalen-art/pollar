import type { RampChain } from '../types';
import {
  defineRampAdapter,
  isRampAdapterError,
  RampAdapterError,
  type RampAdapter,
  type RampAdapterCapabilities,
  type RampAdapterContinuation,
  type RampAdapterCreateRequest,
  type RampAdapterOffer,
  type RampAdapterObservation,
  type RampAdapterOperation,
  type RampAdapterQuoteRequest,
  type RampAdapterRefundRequest,
  type RampAdapterRoute,
  type RampAdapterSubmission,
  type RampAdapterUserContext,
} from './adapter';

const fail = () => new RampAdapterError('INVALID_INPUT', 'correct_input');
function reference(value: string): void {
  if (typeof value !== 'string' || !value.trim()) throw fail();
}
function chain(value: RampChain): void {
  if (value !== 'STELLAR' && value !== 'POLYGON' && value !== 'SOLANA') throw fail();
}
function decimal(value: string, positive = false): void {
  if (typeof value !== 'string' || value.length > 1000 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/.test(value)) throw fail();
  if (positive && !/[1-9]/.test(value)) throw fail();
}
function compare(a: string, b: string): number {
  const [aw = '', af = ''] = a.split('.');
  const [bw = '', bf = ''] = b.split('.');
  const scale = Math.max(af.length, bf.length);
  const left = BigInt(aw + af.padEnd(scale, '0'));
  const right = BigInt(bw + bf.padEnd(scale, '0'));
  return left < right ? -1 : left > right ? 1 : 0;
}
function context(user: RampAdapterUserContext): void {
  for (const value of [user.applicationId, user.sdkUserId, user.providerId, user.configurationId, user.wallet.address])
    reference(value);
  chain(user.wallet.chain);
  if (!['mainnet', 'testnet'].includes(user.wallet.network) || !['custodial', 'external'].includes(user.wallet.custody))
    throw fail();
}
function operation(value: RampAdapterOperation): void {
  for (const id of [value.operationId, value.idempotencyKey, value.transactionId]) reference(id);
  if (value.providerOrderRef !== null) reference(value.providerOrderRef);
}
function route(value: RampAdapterRoute): void {
  for (const id of [value.routeId, value.country, value.fiatCurrency, value.rail, value.asset.code, value.asset.network])
    reference(id);
  chain(value.asset.chain);
  if (!['onramp', 'offramp'].includes(value.direction) || !['fiat', 'crypto'].includes(value.limits.denomination)) throw fail();
  if (!Number.isInteger(value.asset.precision) || value.asset.precision < 0 || value.asset.precision > 1000) throw fail();
  if (value.asset.identifier !== null) reference(value.asset.identifier);
  if (value.limits.min !== null) decimal(value.limits.min);
  if (value.limits.max !== null) decimal(value.limits.max);
  if (value.limits.min !== null && value.limits.max !== null && compare(value.limits.min, value.limits.max) > 0) throw fail();
}
function validateOffer(offer: RampAdapterOffer, selected: RampAdapterRoute): void {
  const terms = offer.terms;
  decimal(terms.fiatAmount, true);
  decimal(terms.cryptoAmount, true);
  decimal(terms.feeAmount);
  reference(terms.feeCurrency);
  if (offer.availableAmount !== null) decimal(offer.availableAmount);
  if (
    terms.fiatCurrency !== selected.fiatCurrency ||
    terms.assetCode !== selected.asset.code ||
    terms.assetChain !== selected.asset.chain ||
    terms.assetIssuer !== selected.asset.identifier ||
    (terms.cryptoAmount.split('.')[1]?.length ?? 0) > selected.asset.precision
  )
    throw fail();
  const limited = selected.limits.denomination === 'fiat' ? terms.fiatAmount : terms.cryptoAmount;
  if (selected.limits.min !== null && compare(limited, selected.limits.min) < 0) throw fail();
  if (selected.limits.max !== null && compare(limited, selected.limits.max) > 0) throw fail();
}
function unexpired(offer: RampAdapterOffer, now: number): void {
  if (offer.providerExpiresAt !== null && !(Date.parse(offer.providerExpiresAt) > now))
    throw new RampAdapterError('QUOTE_EXPIRED', 'requote');
}
function observation(value: RampAdapterObservation): void {
  reference(value.identity);
  reference(value.rawStatus);
  if (value.providerOrderRef !== null) reference(value.providerOrderRef);
  if (!Array.isArray(value.facts) || !Array.isArray(value.proposedActions) || typeof value.verificationRequired !== 'boolean')
    throw fail();
  for (const fact of value.facts) {
    switch (fact.kind) {
      case 'provider_processing':
      case 'provider_rejection_reported':
        break;
      case 'fiat_receipt_reported':
      case 'fiat_payout_reported':
        if (fact.reference !== null) reference(fact.reference);
        break;
      case 'chain_transaction_reported':
        chain(fact.chain);
        reference(fact.hash);
        if (!['source', 'intermediate', 'destination'].includes(fact.leg)) throw fail();
        break;
      default:
        throw fail();
    }
  }
  if (value.payment !== null) {
    chain(value.payment.chain);
    for (const id of [value.payment.network, value.payment.assetCode, value.payment.destination]) reference(id);
    decimal(value.payment.amount, true);
  }
}

/**
 * Explicit dispatch for user-defined adapters. Independent of Pollar authentication,
 * HTTP APIs and global registries; each instance owns its registrations.
 * Calls are single-attempt. Hosts must persist operations and resolve unknown outcomes.
 */
export class RampAdapterClient {
  private readonly adapters = new Map<string, { adapter: RampAdapter }>();
  constructor(
    adapters: readonly RampAdapter[] = [],
    private readonly clock: () => number = Date.now,
  ) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RampAdapter): () => void {
    defineRampAdapter(adapter);
    const id = adapter.adapterId;
    if (this.adapters.has(id)) throw new RampAdapterError('AUTH_CONFIGURATION_ERROR', 'operator');
    const registration = { adapter };
    this.adapters.set(id, registration);
    return () => {
      if (this.adapters.get(id) === registration) this.adapters.delete(id);
    };
  }
  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }
  clear(): void {
    this.adapters.clear();
  }
  private resolve(adapterId: string): RampAdapter {
    const adapter = this.adapters.get(adapterId)?.adapter;
    if (!adapter) throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    if (adapter.adapterId !== adapterId) throw new RampAdapterError('AUTH_CONFIGURATION_ERROR', 'operator');
    return adapter;
  }

  async getCapabilities(adapterId: string, user: RampAdapterUserContext): Promise<RampAdapterCapabilities> {
    context(user);
    const adapter = this.resolve(adapterId);
    const capabilities = await adapter.capabilities(user);
    if (
      (capabilities.callbacks && typeof adapter.verifyAndNormalizeCallback !== 'function') ||
      (capabilities.refunds === 'api' && typeof adapter.refund !== 'function') ||
      (capabilities.continuations?.length && typeof adapter.continue !== 'function')
    )
      throw new RampAdapterError('AUTH_CONFIGURATION_ERROR', 'operator');
    const ids = new Set<string>();
    for (const item of capabilities.routes) {
      route(item);
      if (ids.has(item.routeId)) throw new RampAdapterError('AUTH_CONFIGURATION_ERROR', 'operator');
      ids.add(item.routeId);
    }
    // UI consumers must not mutate the provider's live route configuration.
    return {
      ...capabilities,
      routes: capabilities.routes.map((item) => ({ ...item, asset: { ...item.asset }, limits: { ...item.limits } })),
      ...(capabilities.continuations ? { continuations: [...capabilities.continuations] } : {}),
    };
  }

  async getRoutes(adapterId: string, user: RampAdapterUserContext): Promise<RampAdapterRoute[]> {
    return (await this.getCapabilities(adapterId, user)).routes;
  }

  private async selectedRoute(adapterId: string, requested: RampAdapterRoute, user: RampAdapterUserContext) {
    route(requested);
    const selected = (await this.getRoutes(adapterId, user)).find((item) => item.routeId === requested.routeId);
    if (!selected) throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    // All identity and commercial fields must match the currently advertised route.
    if (
      selected.direction !== requested.direction ||
      selected.country !== requested.country ||
      selected.fiatCurrency !== requested.fiatCurrency ||
      selected.rail !== requested.rail ||
      selected.asset.chain !== requested.asset.chain ||
      selected.asset.network !== requested.asset.network ||
      selected.asset.code !== requested.asset.code ||
      selected.asset.identifier !== requested.asset.identifier ||
      selected.asset.precision !== requested.asset.precision ||
      selected.limits.denomination !== requested.limits.denomination ||
      selected.limits.min !== requested.limits.min ||
      selected.limits.max !== requested.limits.max ||
      user.wallet.chain !== selected.asset.chain ||
      user.wallet.network !== selected.asset.network
    )
      throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    return selected;
  }

  async quote(adapterId: string, input: RampAdapterQuoteRequest): Promise<RampAdapterOffer> {
    const selected = await this.selectedRoute(adapterId, input.route, input.user);
    decimal(input.amount.value, true);
    if (!['fiat', 'crypto'].includes(input.amount.denomination)) throw fail();
    if (input.amount.denomination === selected.limits.denomination) {
      if (selected.limits.min !== null && compare(input.amount.value, selected.limits.min) < 0) throw fail();
      if (selected.limits.max !== null && compare(input.amount.value, selected.limits.max) > 0) throw fail();
    }
    const offer = await this.resolve(adapterId).quote({ ...input, route: selected });
    validateOffer(offer, selected);
    const quoted = input.amount.denomination === 'fiat' ? offer.terms.fiatAmount : offer.terms.cryptoAmount;
    if (compare(quoted, input.amount.value) !== 0) throw new RampAdapterError('QUOTE_CHANGED', 'requote');
    unexpired(offer, this.clock());
    return offer;
  }

  private async creation(adapterId: string, input: Omit<RampAdapterCreateRequest, 'operation' | 'payee'>) {
    const selected = await this.selectedRoute(adapterId, input.route, input.user);
    validateOffer(input.offer, selected);
    unexpired(input.offer, this.clock());
    return { ...input, route: selected };
  }

  async prepare(adapterId: string, input: Parameters<NonNullable<RampAdapter['prepare']>>[0]) {
    const checked = await this.creation(adapterId, input);
    return (await this.resolve(adapterId).prepare?.(checked)) ?? null;
  }

  /** Do not retry an exception: dispatch may already have created an order or moved funds. */
  private async submit(run: () => Promise<RampAdapterSubmission>): Promise<RampAdapterSubmission> {
    try {
      const result = await run();
      if (result.outcome === 'accepted') {
        observation(result.observation);
        return result;
      }
      if ((result.outcome === 'unknown' || result.outcome === 'rejected') && isRampAdapterError(result.error)) {
        const error = new RampAdapterError(result.error.code, result.error.recovery, result.error.status);
        return result.outcome === 'rejected'
          ? { outcome: 'rejected', error }
          : {
              outcome: 'unknown',
              error,
              ...(typeof result.providerOrderRef === 'string' && result.providerOrderRef.trim()
                ? { providerOrderRef: result.providerOrderRef }
                : {}),
            };
      }
    } catch {
      /* No raw errors, response bodies or credentials cross the public boundary. */
    }
    return { outcome: 'unknown', error: new RampAdapterError('OUTCOME_UNKNOWN', 'reconcile') };
  }

  async create(adapterId: string, input: RampAdapterCreateRequest): Promise<RampAdapterSubmission> {
    operation(input.operation);
    const checked = await this.creation(adapterId, input);
    for (const field of input.offer.requiredFields) {
      const value = input.payee[field.key];
      if (!field.optional && (typeof value !== 'string' || !value.trim())) throw fail();
      if (value && field.type === 'select' && field.options && !field.options.some((option) => option.value === value))
        throw fail();
    }
    return this.submit(() => this.resolve(adapterId).create({ ...input, route: checked.route }));
  }

  async getStatus(adapterId: string, input: Parameters<RampAdapter['status']>[0]) {
    context(input.user);
    reference(input.providerOrderRef);
    const result = await this.resolve(adapterId).status(input);
    observation(result);
    if (result.providerOrderRef !== input.providerOrderRef) throw fail();
    return result;
  }
  async reconcile(adapterId: string, input: Parameters<RampAdapter['reconcile']>[0]) {
    context(input.user);
    operation(input.operation);
    const result = await this.resolve(adapterId).reconcile(input);
    if (result !== null) {
      observation(result);
      if (input.operation.providerOrderRef !== null && result.providerOrderRef !== input.operation.providerOrderRef)
        throw fail();
    }
    return result;
  }
  async continue(adapterId: string, input: RampAdapterContinuation): Promise<RampAdapterSubmission> {
    operation(input.operation);
    const capabilities = await this.getCapabilities(adapterId, input.user);
    const adapter = this.resolve(adapterId);
    if (!adapter.continue) throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    reference(input.action.actionId);
    if ('expiresAt' in input.action && input.action.expiresAt !== null && !(Date.parse(input.action.expiresAt) > this.clock()))
      throw new RampAdapterError('QUOTE_EXPIRED', 'requote');
    const kind = input.action.kind;
    if (!['sign_transaction', 'user_ready', 'collect_information', 'verification'].includes(kind))
      throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    const supported = kind === 'sign_transaction' ? 'signed_payload' : kind === 'user_ready' ? 'user_ready' : null;
    if (supported && !capabilities.continuations?.includes(supported))
      throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    if (kind === 'sign_transaction' && !input.signedPayload) throw fail();
    if (
      kind === 'sign_transaction' &&
      (input.action.chain !== input.user.wallet.chain || input.action.network !== input.user.wallet.network)
    )
      throw fail();
    return this.submit(() => adapter.continue!(input));
  }
  async verifyAndNormalizeCallback(
    adapterId: string,
    input: Parameters<NonNullable<RampAdapter['verifyAndNormalizeCallback']>>[0],
  ) {
    const capabilities = await this.getCapabilities(adapterId, input.user);
    const adapter = this.resolve(adapterId);
    if (!capabilities.callbacks || !adapter.verifyAndNormalizeCallback)
      throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    const result = await adapter.verifyAndNormalizeCallback(input);
    observation(result);
    return result;
  }
  async refund(adapterId: string, input: RampAdapterRefundRequest): Promise<RampAdapterSubmission> {
    operation(input.operation);
    reference(input.authorizationRef);
    reference(input.currency);
    decimal(input.amount, true);
    const capabilities = await this.getCapabilities(adapterId, input.user);
    const adapter = this.resolve(adapterId);
    if (capabilities.refunds !== 'api' || !adapter.refund) throw new RampAdapterError('UNSUPPORTED_ROUTE', 'correct_input');
    return this.submit(() => adapter.refund!(input));
  }
}
