# Build a ramp provider with core and run it in Pollar

Applications use this path:

`Application -> @pollar/core -> authenticated Pollar API -> registered server adapter -> provider`

`@pollar/core/ramps` exports the server adapter contract and registration factory. A provider package implements this contract and is installed in Pollar's backend. The backend owns configuration, credentials, application/user scope, persisted quotes, the seven-state lifecycle, durable operations and reconciliation. Applications keep using the existing `PollarClient` methods.

These APIs are source changes pending SDK/backend review and release. They do not publish packages or deploy/enable a real provider.

## Implement a server adapter

Create a server package that exports a factory. Inject the authenticated provider transport from Pollar's configuration resolver. `MyProviderClient` below represents the transport you implement; it must map provider responses into the exported core types.

```ts
import { defineRampAdapter, type RampAdapter } from '@pollar/core/ramps';

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

This code runs in the Pollar server. `provider` calls the external provider; the application does not construct it. The full [example adapter](../../examples/custom-ramp/adapter.ts) shows protocol translation rather than assuming that the external API already returns core's types.

Required methods are `capabilities`, `quote`, `create`, `status` and `reconcile`. Optional methods support preparation, action validation, input mapping, quote comparison, continuation, callback verification, refunds, notification and an independent authenticated fiat receipt reader (`verifySettlement`). Provider status reports and hashes alone cannot establish completion.

Use exact decimal strings in all amounts and terms. Chain identifiers follow `STELLAR`, `POLYGON` and `SOLANA`; rails follow the backend catalog (`SPEI`, `PIX`, `PSE`, `ACH`, `BREB`, `QR`). Additional chains or rails require backend/schema support. Advertise only routes for which the provider account, user wallet, chain executor and independent evidence readers are available.

## Export the server registration

```ts
import { defineRampAdapterRegistration } from '@pollar/core/ramps';

export const registration = defineRampAdapterRegistration('my-provider', {
  defaultChain: 'STELLAR',
  async resolveConfiguration(scope) {
    // Implement on the server using Pollar's configured provider account.
    // The revision must change with account, credentials or environment.
    const configured = await resolveProviderAccount(scope);
    return {
      configurationId: configured.revision,
      client: configured.authenticatedClient,
      timeoutMs: 15000,
      clock: () => new Date(),
      logger: redactingLogger,
    };
  },
  factory: (dependencies) => createMyRamp(dependencies.client),
});
```

`resolveProviderAccount` and `redactingLogger` are server integrations. Keep API keys, signing keys and callback secrets there. `configurationId` is an opaque revision, not the secret itself. The [server example](../../examples/custom-ramp/server.ts) exposes an injected resolver so the backend can supply its actual credential store/transport without embedding secrets in the SDK.

## Install in Pollar's backend

During trusted SDK API startup, import the installed provider package and register it:

```ts
// pollar-platform/apps/sdk-api/src/ramps/bootstrap.ts
import { registration } from '@your-org/pollar-ramp-my-provider';
import { registerCoreRampAdapter } from './registry.js';

registerCoreRampAdapter(registration);
```

The backend pairs the configuration resolver with the factory, validates the returned adapter identity and uses it through the existing orchestrator. There is no browser-side provider registration, uploaded JavaScript or remote module loading endpoint.

Configure the provider catalog row with `adapter = GENERIC` and `adapter_key = my-provider`, its supported/enabled corridors and matching network. Link/enable it for the application using the existing provider administration flow. Enroll the provider through the existing adapter-provider configuration (`SDK_RAMP_ADAPTER_PROVIDERS`); keep chain, wallet and trusted fiat verification gates enabled. Installing the package alone does not bypass these operational checks.

The public contract is authored in core. Until a published core release contains it, the companion backend consumes a generated, revision/hash-pinned source snapshot in its private `@pollar/ramp-adapter-contract` workspace package. Its synchronization check prevents editing a separate handwritten backend contract. New SDK changes must regenerate that snapshot; no sibling checkout or unpublished npm version is required in production installs.

## Consume it from an application

Use an existing authenticated client. Core sends each request to Pollar; the backend finds the enabled registered provider and persists its operations.

```ts
const { routes } = await client.getRampRoutes();
// Show eligible routes and let the user select one.
const result = await client.getRampsQuote({
  direction: route.direction,
  routeId: route.routeId,
  country: route.country,
  currency: route.fiatCurrency,
  amount: 100,
  amountExact: '100',
});

// Complete result.requirementsRequired when present, and show the chosen offer.
// After the user accepts its current terms and supplies required fields:
const tx = await client.createOnRamp({
  quoteId: quote.quoteId,
  country: route.country,
  currency: route.fiatCurrency,
  amount: quote.fiatAmount,
  amountExact: quote.terms?.fiatAmount,
  fields: collectedFields,
});
const saved = await client.getRampTransaction(tx.txId);
```

For withdrawal, use `createOffRamp` with the required payout fields. Render `nextAction` using the existing workflow helpers. Use `continueRamp`/`signRampAction` after explicit user interaction; the backend binds the saved action ID and transaction version and controls submission. Resume the same `txId` after a reload or timeout. Do not create a replacement order to refresh its status.

There is no local `client.rampAdapters` executor or `registerRampAdapter` application method. Those appeared in the earlier, unmerged draft and have been removed so applications always use Pollar's orchestration for their ramp transactions.

See the type-checked [application example](../../examples/custom-ramp/client.ts). To validate this SDK checkout:

```sh
npm run build --workspace @pollar/core
npm run test:custom-ramp-example
node tests/smoke-custom-ramp.cjs
```

The companion backend integration tests exercise the actual SDK methods through its HTTP controllers and disposable PostgreSQL, including persisted quote/transaction/operation identities, ownership, replay and unknown-outcome recovery. They use injected observations and never create live payments.
