// SPDX-License-Identifier: Apache-2.0
// Canonical server adapter contract. Kept independent of generated HTTP schemas.
export type RampAdapterChain = 'STELLAR' | 'POLYGON' | 'SOLANA';
export type RampAdapterRail = 'SPEI' | 'PIX' | 'PSE' | 'ACH' | 'BREB' | 'QR';
export type RampAdapterTerms = {
  fiatCurrency: string;
  fiatAmount: string;
  cryptoAmount: string;
  feeAmount: string;
  feeCurrency: string;
  assetCode: string;
  assetChain: RampAdapterChain;
  assetIssuer: string | null;
};

/** Provider amounts are exact decimal strings, never IEEE-754 calculations. */
export type RampDecimal = string;
export type RampAdapterRoute = {
  routeId: string;
  direction: 'onramp' | 'offramp';
  country: string;
  fiatCurrency: string;
  rail: RampAdapterRail;
  asset: { code: string; identifier: string | null; chain: RampAdapterChain; network: string; precision: number };
  limits: { denomination: 'fiat' | 'crypto'; min: RampDecimal | null; max: RampDecimal | null };
};

/** Supplied by the host after authentication; the SDK does not authorize this context. */
export type RampAdapterUserContext = {
  applicationId: string;
  sdkUserId: string;
  providerId: string;
  configurationId: string;
  wallet: { address: string; chain: string; network: 'testnet' | 'mainnet'; custody: 'custodial' | 'external' };
};
export type RampAdapterField = {
  key: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'select';
  optional?: boolean;
  bankType?: string;
  options?: Array<{ value: string; label: string; placeholder?: string }>;
  placeholder?: string;
  placeholderFrom?: string;
  hint?: string;
};
export type RampAdapterAction =
  | { kind: 'collect_information'; fields: RampAdapterField[] }
  | { kind: 'hosted_redirect'; purpose: 'verification' | 'payment'; url: string; expiresAt: string | null }
  | { kind: 'qr_payment'; payload: string; amount: RampDecimal; currency: string; expiresAt: string | null }
  | {
      kind: 'bank_transfer';
      amount: RampDecimal;
      currency: string;
      details: Array<{ label: string; value: string }>;
      reference: string | null;
      expiresAt: string | null;
    }
  | { kind: 'user_ready'; purpose: 'create_order' | 'withdrawal_payment' | 'onramp_claim' }
  | {
      kind: 'verification';
      steps: Array<{
        stepId: string;
        purpose: 'verification' | 'terms';
        status: 'required' | 'awaiting_provider' | 'completed';
        url: string | null;
        instructions: string;
      }>;
      order: 'parallel' | 'sequential';
    }
  | {
      kind: 'chain_transfer';
      chain: string;
      network: string;
      asset: RampAdapterRoute['asset'];
      amount: RampDecimal;
      destination: string;
      memo: { type: string; value: string } | null;
    }
  | {
      kind: 'sign_transaction';
      purpose: 'authentication' | 'withdrawal_payment' | 'onramp_claim';
      chain: string;
      network: string;
      challengeRef: string;
      payload: { encoding: string; value: string };
      expiresAt: string;
    }
  | { kind: 'wait'; reason: 'verification_pending' | 'provider_processing' | 'settlement_verification' | 'reconciliation' };
export type RampAdapterPublicAction = RampAdapterAction & { actionId: string };
export type RampAdapterQuoteRequest = {
  route: RampAdapterRoute;
  amount: { value: RampDecimal; denomination: 'fiat' | 'crypto' };
  user: RampAdapterUserContext;
};
export type RampAdapterOffer = {
  providerQuoteRef: string | null;
  providerExpiresAt: string | null;
  terms: RampAdapterTerms;
  requiredFields: RampAdapterField[];
  availableAmount: RampDecimal | null;
  kind?: 'firm' | 'indicative';
};
/** Persist before dispatch. Reuse these identities when reconciling an unknown outcome. */
export type RampAdapterOperation = {
  operationId: string;
  idempotencyKey: string;
  transactionId: string;
  providerOrderRef: string | null;
};
export type RampAdapterErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_ROUTE'
  | 'QUOTE_CHANGED'
  | 'QUOTE_EXPIRED'
  | 'VERIFICATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'AUTH_CONFIGURATION_ERROR'
  | 'OUTCOME_UNKNOWN';
const errorBrand = Symbol.for('@pollar/core/RampAdapterError');
const errorCodes = new Set<string>([
  'INVALID_INPUT',
  'UNSUPPORTED_ROUTE',
  'QUOTE_CHANGED',
  'QUOTE_EXPIRED',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'AUTH_CONFIGURATION_ERROR',
  'OUTCOME_UNKNOWN',
]);
/** Public, redacted error. Do not include provider credentials or raw response bodies. */
export class RampAdapterError extends Error {
  constructor(
    readonly code: RampAdapterErrorCode,
    readonly recovery: 'correct_input' | 'requote' | 'retry_read' | 'reconcile' | 'operator',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'RampAdapterError';
    Object.defineProperty(this, errorBrand, { value: true });
  }
}
/** Works across the root, portable, native, ESM and CJS package entry points. */
export function isRampAdapterError(value: unknown): value is RampAdapterError {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<PropertyKey, unknown>;
  return (
    item[errorBrand] === true &&
    typeof item.code === 'string' &&
    errorCodes.has(item.code) &&
    typeof item.recovery === 'string' &&
    ['correct_input', 'requote', 'retry_read', 'reconcile', 'operator'].includes(item.recovery) &&
    (item.status === undefined ||
      (typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599))
  );
}
export type RampAdapterPayment = {
  chain: string;
  network: string;
  assetCode: string;
  identifier: string | null;
  precision?: number;
  amount: RampDecimal;
  destination: string;
  memo: string | { type: string; value: string } | null;
  notifyEndpoint: string | null;
};
/** Reports are observations, not verified fiat/chain settlement or lifecycle completion. */
export type RampAdapterFact =
  | { kind: 'provider_processing' }
  | { kind: 'fiat_receipt_reported' | 'fiat_payout_reported'; reference: string | null }
  | { kind: 'chain_transaction_reported'; chain: string; hash: string; leg: 'source' | 'intermediate' | 'destination' }
  | { kind: 'provider_rejection_reported' };
export type RampAdapterObservation = {
  providerOrderRef: string | null;
  identity: string;
  rawStatus: string;
  facts: RampAdapterFact[];
  proposedActions: RampAdapterAction[];
  verificationRequired: boolean;
  payment: RampAdapterPayment | null;
};
export type RampAdapterSubmission =
  | { outcome: 'accepted'; observation: RampAdapterObservation }
  | { outcome: 'rejected'; error: RampAdapterError }
  | { outcome: 'unknown'; error: RampAdapterError; providerOrderRef?: string };
export type RampAdapterCapabilities = {
  routes: RampAdapterRoute[];
  callbacks: boolean;
  polling: boolean;
  providerIdempotency: boolean;
  operationLookup: boolean;
  fiatPayoutEvidence: boolean;
  keyRetentionSeconds: number | null;
  refunds?: 'api' | 'manual' | 'unsupported';
  continuations?: Array<'user_ready' | 'signed_payload' | 'funding_verified'>;
};
export type RampAdapterCreateRequest = {
  operation: RampAdapterOperation;
  user: RampAdapterUserContext;
  route: RampAdapterRoute;
  offer: RampAdapterOffer;
  payee: Record<string, string>;
};
export type RampAdapterContinuation = {
  operation: RampAdapterOperation;
  action: RampAdapterPublicAction;
  user: RampAdapterUserContext;
  signedPayload?: string;
  fields?: Record<string, string>;
};
export type RampAdapterRefundRequest = {
  operation: RampAdapterOperation;
  user: RampAdapterUserContext;
  authorizationRef: string;
  amount: RampDecimal;
  currency: string;
};

export type RampAdapterFiatEvidence = {
  kind: 'fiat_confirmed';
  reference: string;
  verifier: string;
  purpose: 'receipt' | 'payout';
  currency: string;
  amount: RampDecimal;
  authenticated: true;
};
export type RampAdapterSettlementVerifier = (input: {
  user: RampAdapterUserContext;
  terms: RampAdapterTerms;
  providerOrderRef: string;
  observation: RampAdapterObservation;
}) => Promise<RampAdapterFiatEvidence | null>;

/**
 * Implement on the Pollar server with an injected authenticated provider client.
 * Install its registration in the backend; applications consume the existing HTTP API.
 * Pollar owns persistence, authorization, operation dispatch and verified settlement.
 */
export interface RampAdapter {
  readonly adapterId: string;
  readonly protocol?: 'SEP-24' | 'REST';
  /** Server-trusted authenticated receipt reader. A status report alone is not a receipt. */
  verifySettlement?: RampAdapterSettlementVerifier;
  capabilities(user: RampAdapterUserContext): Promise<RampAdapterCapabilities>;
  quote(input: RampAdapterQuoteRequest): Promise<RampAdapterOffer>;
  create(input: RampAdapterCreateRequest): Promise<RampAdapterSubmission>;
  status(input: { providerOrderRef: string; user: RampAdapterUserContext }): Promise<RampAdapterObservation>;
  reconcile(input: { operation: RampAdapterOperation; user: RampAdapterUserContext }): Promise<RampAdapterObservation | null>;
  prepare?(input: {
    user: RampAdapterUserContext;
    route: RampAdapterRoute;
    offer: RampAdapterOffer;
  }): Promise<RampAdapterAction | null>;
  validateAction?(input: {
    action: RampAdapterAction;
    user: RampAdapterUserContext;
    route: RampAdapterRoute;
    offer: RampAdapterOffer;
    signedPayload?: string;
  }): Promise<void>;
  mapInputs?(input: Record<string, unknown>): Record<string, string>;
  quotePolicy?(input: { route: RampAdapterRoute; saved: RampAdapterOffer; refreshed: RampAdapterOffer }): boolean;
  continue?(input: RampAdapterContinuation): Promise<RampAdapterSubmission>;
  verifyAndNormalizeCallback?(input: {
    rawBody: Uint8Array;
    headers: Record<string, string>;
    user: RampAdapterUserContext;
  }): Promise<RampAdapterObservation>;
  refund?(input: RampAdapterRefundRequest): Promise<RampAdapterSubmission>;
  notify?(input: { providerOrderRef: string; user: RampAdapterUserContext; hash: string; endpoint: string }): Promise<void>;
}

/** Preserves class/prototype methods and injected dependencies; performs no I/O. */
export function defineRampAdapter<T extends RampAdapter>(adapter: T): T {
  if (typeof adapter.adapterId !== 'string' || !adapter.adapterId.trim() || adapter.adapterId !== adapter.adapterId.trim())
    throw new RampAdapterError('INVALID_INPUT', 'correct_input');
  for (const method of ['capabilities', 'quote', 'create', 'status', 'reconcile'] as const)
    if (typeof adapter[method] !== 'function') throw new RampAdapterError('INVALID_INPUT', 'correct_input');
  return adapter;
}

/** Server scope resolved by Pollar, never taken from a frontend registration request. */
export type RampAdapterProviderScope = { applicationId: string; providerId: string; network: 'mainnet' | 'testnet' };
export type RampAdapterDependencies<Client = unknown> = {
  configurationId: string;
  client: Client;
  timeoutMs: number;
  clock: () => Date;
  logger: { warn(message: string, fields: { code: string }): void };
};
export type RampAdapterRegistration<Client = unknown> = {
  defaultChain: RampAdapterChain;
  resolveConfiguration(scope: RampAdapterProviderScope): Promise<RampAdapterDependencies<Client>>;
  factory(dependencies: RampAdapterDependencies<Client>): RampAdapter;
};
export type RampAdapterPlugin<Client = unknown> = RampAdapterRegistration<Client> & { readonly adapterId: string };
/** Installed during backend startup. This does not upload code or credentials from a browser. */
export function defineRampAdapterRegistration<Client>(
  adapterId: string,
  registration: RampAdapterRegistration<Client>,
): RampAdapterPlugin<Client> {
  if (
    !adapterId?.trim() ||
    adapterId !== adapterId.trim() ||
    !['STELLAR', 'POLYGON', 'SOLANA'].includes(registration.defaultChain) ||
    typeof registration.resolveConfiguration !== 'function' ||
    typeof registration.factory !== 'function'
  )
    throw new RampAdapterError('INVALID_INPUT', 'operator');
  return { ...registration, adapterId };
}
