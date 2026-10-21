// Application side: an existing authenticated PollarClient talks only to Pollar's backend.
import type { PollarClient, RampRoute, RampsQuoteResponse } from '@pollar/core';

export function discoverRamps(client: PollarClient) {
  return client.getRampRoutes();
}

export function quoteRamp(client: PollarClient, route: RampRoute, amountExact: string) {
  return client.getRampsQuote({
    routeId: route.routeId,
    direction: route.direction,
    country: route.country,
    currency: route.fiatCurrency,
    amount: Number(amountExact),
    amountExact,
  });
}

/** Call after the user selects and accepts a backend-issued quote; do not invent quote IDs. */
export function startDeposit(
  client: PollarClient,
  route: RampRoute,
  quote: RampsQuoteResponse['quotes'][number],
  fields: Record<string, string>,
) {
  return client.createOnRamp({
    quoteId: quote.quoteId,
    country: route.country,
    currency: route.fiatCurrency,
    amount: quote.fiatAmount,
    ...(quote.terms ? { amountExact: quote.terms.fiatAmount } : {}),
    fields,
  });
}

export function readSavedRamp(client: PollarClient, txId: string) {
  return client.getRampTransaction(txId);
}
