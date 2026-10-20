# Build a ramp provider with `@pollar/core`

The public extension contract lets you build and distribute a provider adapter in your own package without changing Pollar's backend. Import from `@pollar/core`, or use the portable `@pollar/core/ramps` entry point in a server, worker, browser or React Native application. The portable entry does not initialize wallets, authentication or HTTP clients.

This API is new source code in this change; use a build that includes it. Registration is local to your instance. It does not enroll the provider in Pollar's hosted service, publish a package, or make it appear in the existing hosted `client.getRampRoutes()` response.

## Implement the provider boundary

Export a factory that accepts an authenticated provider client or your own server proxy. Keep credentials inside the server implementation when the provider requires secrets. Do not put provider API keys, callback verification secrets or private signing keys in a browser/mobile bundle.

```ts
import { defineRampAdapter, type RampAdapter } from '@pollar/core/ramps';

// See examples/custom-ramp/adapter.ts for the complete implementation.
export function createMyRamp(provider: MyProviderClient): RampAdapter {
  return defineRampAdapter({
    adapterId: 'my-provider',
    capabilities: (user) => provider.capabilities(user),
    quote: (input) => provider.quote(input),
    create: (input) => provider.create(input),
    status: (input) => provider.status(input),
    reconcile: (input) => provider.reconcile(input),
  });
}
```

Here `MyProviderClient` is an application-owned transport that maps its provider protocol to the exported adapter types. The full example demonstrates that mapping instead of assuming provider responses already follow this contract.

Required methods:

| Method               | Responsibility                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `capabilities(user)` | Advertise executable routes and supported operations for this account/configuration.            |
| `quote(input)`       | Return exact commercial terms and provider quote expiry.                                        |
| `create(input)`      | Submit a single operation using its persisted identity and provider idempotency key.            |
| `status(input)`      | Read a known provider order without creating payments/orders.                                   |
| `reconcile(input)`   | Recover the original outcome/reference, including lookup by operation identity after a timeout. |

Optional methods cover `prepare`, `validateAction`, field mapping, quote comparison, `continue`, authenticated callback normalization, refunds and notification. The host can call `validateAction`, `mapInputs`, `quotePolicy` and `notify` on its adapter during its own durable orchestration. The dispatcher never invents that policy or automatically sends notifications.

Declare optional capabilities truthfully: `callbacks: true` requires `verifyAndNormalizeCallback`; API refunds require `refund`; advertised continuations require `continue`. Chains use the existing `STELLAR | POLYGON | SOLANA` catalog. Provider IDs and payment rail names can be application-defined. Networks are separate from chains. Another chain requires extending the shared types and verification/signing support.

## Register and execute

The extension runtime can run without a Pollar API key or Pollar session:

```ts
import { RampAdapterClient } from '@pollar/core/ramps';

const adapter = createMyRamp(providerClient);
const ramps = new RampAdapterClient([adapter]);
const routes = await ramps.getRoutes(adapter.adapterId, userContext);

// The user selects a route and confirms the amount.
const offer = await ramps.quote(adapter.adapterId, {
  route: selectedRoute,
  user: userContext,
  amount: { value: '100.0000001', denomination: 'fiat' },
});

// Persist the accepted offer, route, payee and identities before dispatch.
const result = await ramps.create(adapter.adapterId, {
  route: selectedRoute,
  user: userContext,
  offer,
  operation: savedOperation,
  payee: collectedPayeeFields,
});

if (result.outcome === 'accepted') {
  // Persist the observation and provider reference. Accepted means submission
  // was accepted, not that fiat and chain settlement are completed.
} else if (result.outcome === 'unknown') {
  // Keep the same transaction/operation. Schedule reconciliation, not creation.
  const recovered = await ramps.reconcile(adapter.adapterId, {
    user: userContext,
    operation: savedOperation,
  });
} else {
  // Render the public error code/recovery action.
}
```

The identifiers in `RampAdapterUserContext` belong to the host's authenticated application/user/provider/configuration. They are not authenticated by the SDK, and a configuration ID must change when the provider account, credentials or environment changes. Never trust context or a saved offer supplied by an unauthenticated caller. The host authenticates the request, loads its persisted offer/action and checks authorization before invoking server-side adapters.

`RampAdapterOperation` requires `operationId`, `idempotencyKey`, `transactionId` and a nullable `providerOrderRef`. Generate and persist these once for each logical operation. Provider key retention and lookup guarantees must be verified for the real integration. An in-memory SDK instance does not provide durable idempotency, locking, webhook delivery or a transaction database.

Each submission is attempted once. A thrown or malformed submission response becomes `outcome: 'unknown'` with `OUTCOME_UNKNOWN/reconcile`; it is never retried automatically and raw exception details are not returned. Explicit `rejected` and `unknown` results use `RampAdapterError`. Use `isRampAdapterError(error)` across package entry points instead of `instanceof`, since ESM/CJS/native bundles can contain different class instances.

Exact amounts are decimal strings. Quote and creation validate route identity, asset/issuer, chain/network, precision, limits and expiry. The dispatcher preserves the supplied operation identity, payee and exact terms; it does not calculate exchange rates with floating point. A provider may impose additional constraints in its adapter. A renewed quote requires showing and accepting the new terms through the host's workflow.

## Use an existing `PollarClient`

```ts
import { PollarClient } from '@pollar/core';

const client = new PollarClient({
  apiKey: appApiKey,
  rampAdapters: [createMyRamp(providerProxy)],
});

// Or register after construction:
const unregister = client.registerRampAdapter(otherAdapter);

const customRoutes = await client.rampAdapters.getRoutes('my-provider', userContext);
// quote/create/getStatus/reconcile/continue/refund use this same namespace.

unregister();
client.destroy(); // Clears this client's custom registrations.
```

`client.getRampRoutes()`, `getRampsQuote()`, `createOnRamp()` and the other existing ramp methods continue to call Pollar's hosted API. `client.rampAdapters` executes application-owned providers. This explicit separation prevents a local provider response from being mistaken for a Pollar-persisted, authorized or verified transaction. Reuse the standalone client in applications that only need the adapter framework.

## Actions, signing, callbacks and settlement

Adapters return `proposedActions` using the shared action vocabulary. The host assigns and persists action IDs/versions and can project its saved state into `describeRampAction`/`mergeRampSnapshot` for a custom UI. A provider-specific action may require additional UI support.

Call `ramps.continue(id, input)` only after explicit interaction. The host must load and validate the saved action, transaction version, accepted destination/amount and account ownership before invoking it. Signed actions must match the wallet's chain/network and not be expired. The dispatcher does not sign or broadcast. Use your wallet integration to inspect and sign the requested payload. Existing `client.signRampAction()` belongs to the hosted transaction workflow; custom transactions need their own saved-action validation and signer orchestration.

Call `verifyAndNormalizeCallback` with the original raw bytes and headers, on the server where verification secrets are available. Its adapter must authenticate the provider's actual callback scheme and reject invalid events before returning observations. A test fixture signature is not a production verifier.

Observations contain provider-reported facts, separate source/intermediary/destination hashes and proposed actions. They do not establish the seven-state lifecycle's `completed` or `refunded` states. The host must independently verify required fiat and chain obligations, exact asset/amount, network, destination/memo and successful settlement; retain mismatches/reversals for reconciliation. A receipt or reported hash alone is insufficient. Operator authorization for refunds belongs to the host; `authorizationRef` identifies that decision and is not an authorization check performed by the SDK.

## Run the complete example

From this repository, after `npm ci`:

```sh
npm run build --workspace @pollar/core
npm run test:custom-ramp-example
node tests/smoke-custom-ramp.cjs
```

[`examples/custom-ramp/adapter.ts`](../../examples/custom-ramp/adapter.ts) implements both directions against an injected provider client. [`demo.ts`](../../examples/custom-ramp/demo.ts) runs quote, creation, status and reference recovery for deposits and withdrawals with a disposable fake provider. It makes no HTTP requests or payments. Replace the fake transport with your provider or authenticated proxy and add provider-specific contract/sandbox validation before enabling real funds.
