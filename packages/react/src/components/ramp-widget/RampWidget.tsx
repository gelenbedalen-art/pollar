'use client';

import type {
  PollarClient,
  RampDirection,
  RampOrder,
  RampQuote,
  RampQuoteRejection,
  RampRoute,
  RampSigningHandler,
} from '@pollar/core';
import { appUnavailableMessage, assertRampStellarSigner, isPollarApiError, rampCountries, rampQuoteFields } from '@pollar/core';
import { useEffect, useMemo, useState } from 'react';
import { usePollar } from '../../context';
import type { RampStep } from './RampWidgetTemplate';
import { assetKey, fiatKey, RampWidgetTemplate } from './RampWidgetTemplate';
import '../shared.css';
import './RampWidget.css';
import { modalChrome } from '../modal-theme';

interface RampWidgetProps {
  onClose: () => void;
}

/** Ramp failures a user can act on, by API code. */
const RAMP_ERROR_MESSAGES: Record<string, string> = {
  SDK_RAMPS_QUOTE_EXPIRED: 'This quote expired. Find a route again.',
  SDK_RAMPS_QUOTE_NOT_FOUND: 'This quote is no longer available. Find a route again.',
  SDK_RAMPS_ACTION_STALE: 'This step changed. It was refreshed; try again.',
  SDK_RAMPS_TX_NOT_FOUND: 'This operation was not found.',
};

/** The text for a failed ramp call: an app that cannot serve it, a known code, the server's reason, or the fallback. */
function rampErrorMessage(error: unknown, fallback: string): string {
  const unavailable = appUnavailableMessage(error);
  if (unavailable) return unavailable;
  if (isPollarApiError(error)) {
    const known = RAMP_ERROR_MESSAGES[error.code];
    if (known) return known;
    const message = error.body.message;
    if (typeof message === 'string' && message && !/^[A-Z0-9_]+$/.test(message)) return message;
  }
  return fallback;
}

/** An exact decimal, as the API takes amounts: "10", "10.5", never "1e3" or "-2". */
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Signs a leg, lending the user's own connected wallet as the ramp signer while
 * it does: the wallet (Freighter, Phantom...) shows the transaction and the
 * user approves it there. Core keeps no built-in ramp signer; an app that
 * registered its own signer for a chain keeps it, and the widget's are released
 * once the leg is signed.
 */
async function signLegWithWallet(client: PollarClient, orderId: string, actionId: string): Promise<RampOrder> {
  const lent: Array<() => void> = [];
  const lend = (chain: 'STELLAR' | 'SOLANA', encoding: string, handler: RampSigningHandler) => {
    try {
      lent.push(client.registerRampSigningHandler(chain, encoding, handler));
    } catch {
      // The app registered its own signer for this chain: that one signs.
    }
  };
  lend('STELLAR', 'xdr', async (action) => {
    const wallet = client.getWallet();
    if (!wallet) throw new Error('Connect the Stellar wallet this step was built for.');
    assertRampStellarSigner(action, wallet.address);
    const outcome = await client.signTx(action.payload.value);
    if (client.getWallet()?.address !== wallet.address)
      throw new Error('The connected wallet changed. Refresh before signing.');
    if (outcome.status === 'signed') return outcome.signedXdr;
    throw new Error(
      outcome.status === 'error' ? (outcome.message ?? outcome.details ?? 'Signing was cancelled.') : 'Signing was cancelled.',
    );
  });
  lend('SOLANA', 'solana-v0-json', async (action) => {
    // The server built the transfer from the user's wallet; sign only one from the wallet connected now.
    const payload = JSON.parse(action.payload.value) as { from?: string; unsignedTransaction?: string };
    const solanaWallet = () => client.getWallets().find((w) => w.chain === 'SOLANA' && w.custody === 'external');
    const wallet = solanaWallet();
    if (!wallet || payload.from !== wallet.address || !payload.unsignedTransaction)
      throw new Error('This step must be signed by the Solana wallet it was built for. Reconnect that wallet.');
    const signed = await client.signSolanaTransaction(payload.unsignedTransaction);
    if (solanaWallet()?.address !== wallet.address) throw new Error('The connected wallet changed. Refresh before signing.');
    return signed;
  });
  try {
    return await client.signRampLeg(orderId, actionId);
  } finally {
    for (const release of lent) release();
  }
}

export function RampWidget({ onClose }: RampWidgetProps) {
  const { getClient, styles, network, openCosignModal } = usePollar();
  const client = getClient();
  const { theme, accentColor, styleOverrides, overlayStyle } = modalChrome(styles);

  const [step, setStep] = useState<RampStep>('input');
  const [direction, setDirection] = useState<RampDirection>('ONRAMP');
  const [routes, setRoutes] = useState<RampRoute[]>([]);
  const [routesLoading, setRoutesLoading] = useState(true);
  const [country, setCountry] = useState('');
  const [fiatChoice, setFiatChoice] = useState('');
  const [assetChoice, setAssetChoice] = useState('');
  const [amount, setAmount] = useState('');
  const [quotes, setQuotes] = useState<RampQuote[]>([]);
  const [rejected, setRejected] = useState<RampQuoteRejection[]>([]);
  const [selected, setSelected] = useState<RampQuote | null>(null);
  const [startingQuoteId, setStartingQuoteId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<RampOrder | null>(null);
  const [pendingOrders, setPendingOrders] = useState<RampOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const countries = useMemo(() => rampCountries(routes), [routes]);
  const fiats = countries.find((c) => c.country === country)?.fiats ?? [];
  const fiat = fiats.find((f) => fiatKey(f) === fiatChoice) ?? fiats[0] ?? null;
  const assets = useMemo(() => {
    const seen = new Map<string, RampRoute['asset']>();
    for (const route of routes)
      if (fiat && route.fiat.country === country && fiatKey(route.fiat) === fiatKey(fiat))
        seen.set(assetKey(route.asset), route.asset);
    return [...seen.values()];
  }, [routes, country, fiat]);
  const asset = assets.find((a) => assetKey(a) === assetChoice) ?? assets[0] ?? null;
  const fields = selected ? rampQuoteFields(selected) : [];

  async function loadRoutes(next: RampDirection) {
    setRoutesLoading(true);
    try {
      const { routes: found } = await client.getRampRoutes(next);
      setRoutes(found);
      const first = rampCountries(found)[0]?.country ?? '';
      setCountry((current) => (found.some((r) => r.fiat.country === current) ? current : first));
    } catch (error) {
      setRoutes([]);
      setErrorMsg(rampErrorMessage(error, 'Could not load the ramp routes.'));
    } finally {
      setRoutesLoading(false);
    }
  }

  async function loadPendingOrders() {
    try {
      const page = await client.listRampOrders({ pending: 'true', limit: 5 });
      setPendingOrders(page.orders);
    } catch {
      setPendingOrders([]);
    }
  }

  useEffect(() => {
    void loadRoutes(direction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, direction]);

  useEffect(() => {
    void loadPendingOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Follow the order at the pace the server suggests until it settles. Reading never signs or approves.
  const orderId = order?.id ?? null;
  useEffect(() => {
    if (step !== 'status' || !orderId) return;
    const controller = new AbortController();
    client.pollRampOrder(orderId, { signal: controller.signal, onUpdate: setOrder }).catch(() => {});
    return () => controller.abort();
  }, [client, step, orderId]);

  function handleDirectionChange(next: RampDirection) {
    setDirection(next);
    setErrorMsg(null);
  }

  async function handleFindRoute() {
    if (!fiat || !asset) return;
    if (!DECIMAL.test(amount.trim()) || Number(amount) <= 0) {
      setErrorMsg('Enter an amount greater than zero.');
      return;
    }
    setStep('loading_quote');
    setErrorMsg(null);
    setSelected(null);
    try {
      const result = await client.quoteRamp({
        direction,
        fiat: { currency: fiat.currency, rail: fiat.rail, country: fiat.country },
        asset: { code: asset.code, identifier: asset.identifier, chain: asset.chain },
        amount: { value: amount.trim(), denomination: 'in' },
      });
      setQuotes(result.quotes);
      setRejected(result.rejected);
      setStep('select_route');
    } catch (error) {
      if (isPollarApiError(error) && error.code === 'SDK_RAMPS_NO_ROUTE') {
        setQuotes([]);
        setRejected(Array.isArray(error.body.rejected) ? (error.body.rejected as RampQuoteRejection[]) : []);
        setStep('select_route');
        return;
      }
      setErrorMsg(rampErrorMessage(error, 'Could not find a route. Please try again.'));
      setStep('error');
    }
  }

  function handleSelectQuote(quote: RampQuote) {
    setSelected(quote);
    setErrorMsg(null);
    const missing = rampQuoteFields(quote).some((f) => !f.optional && !(fieldValues[f.key] ?? '').trim());
    if (missing) setStep('contact');
    else void startOrder(quote);
  }

  async function startOrder(quote: RampQuote) {
    setIsLoading(true);
    setStartingQuoteId(quote.quoteId);
    setErrorMsg(null);
    try {
      const payee = Object.fromEntries(
        rampQuoteFields(quote)
          .map((f) => [f.key, (fieldValues[f.key] ?? '').trim()])
          .filter(([, value]) => value),
      );
      const created = await client.createRampOrder({
        quoteId: quote.quoteId,
        ...(Object.keys(payee).length ? { payee } : {}),
      });
      setOrder(created);
      setStep('status');
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, 'Could not start the operation. Please try again.'));
      // A refused detail is fixed on the form; an expired quote needs a new one.
      if (isPollarApiError(error) && error.code === 'VALIDATION_ERROR' && rampQuoteFields(quote).length) setStep('contact');
      else setStep('select_route');
    } finally {
      setIsLoading(false);
      setStartingQuoteId(null);
    }
  }

  async function handleSign() {
    const action = order?.pendingAction;
    if (!order || action?.kind !== 'SIGNATURE' || signing) return;
    setSigning(true);
    setErrorMsg(null);
    try {
      setOrder(await signLegWithWallet(client, order.id, action.actionId));
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, error instanceof Error && error.message ? error.message : 'Signing was cancelled.'));
      setOrder(await client.getRampOrder(order.id).catch(() => order));
    } finally {
      setSigning(false);
    }
  }

  async function handleResumeOrder(id: string) {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const found = await client.getRampOrder(id);
      setDirection(found.direction);
      setOrder(found);
      setStep('status');
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, 'Could not resume the operation.'));
    } finally {
      setIsLoading(false);
    }
  }

  function handleNewOrder() {
    setOrder(null);
    setSelected(null);
    setQuotes([]);
    setRejected([]);
    setErrorMsg(null);
    setStep('input');
    void loadPendingOrders();
  }

  function handleBack() {
    setErrorMsg(null);
    setStep(step === 'contact' ? 'select_route' : 'input');
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (step === 'status' && order) setOrder(await client.getRampOrder(order.id));
      else if (step === 'select_route') await handleFindRoute();
      else {
        await loadRoutes(direction);
        await loadPendingOrders();
      }
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, 'Could not refresh.'));
    } finally {
      setRefreshing(false);
    }
  }

  const flowSteps =
    fields.length || quotes.some((q) => rampQuoteFields(q).length)
      ? ['Amount', 'Route', 'Details', 'Complete']
      : ['Amount', 'Route', 'Complete'];
  const stepLabel: Partial<Record<RampStep, string>> = {
    input: 'Amount',
    loading_quote: 'Amount',
    select_route: 'Route',
    contact: 'Details',
    status: 'Complete',
  };
  const label = stepLabel[step];

  return (
    <div className="pollar-overlay" style={overlayStyle} onClick={onClose}>
      <RampWidgetTemplate
        theme={theme}
        accentColor={accentColor}
        {...(styleOverrides ? { styleOverrides } : {})}
        network={network}
        step={step}
        flowSteps={flowSteps}
        flowStepIndex={label ? flowSteps.indexOf(label) : -1}
        direction={direction}
        routesLoading={routesLoading}
        countries={countries}
        country={country}
        fiats={fiats}
        fiat={fiat}
        assets={assets}
        asset={asset}
        amount={amount}
        quotes={quotes}
        rejected={rejected}
        startingQuoteId={startingQuoteId}
        fields={fields}
        fieldValues={fieldValues}
        order={order}
        pendingOrders={pendingOrders}
        isLoading={isLoading}
        refreshing={refreshing}
        signing={signing}
        errorMsg={errorMsg}
        onDirectionChange={handleDirectionChange}
        onCountryChange={(next) => {
          setCountry(next);
          setFiatChoice('');
          setAssetChoice('');
        }}
        onFiatChange={(key) => {
          setFiatChoice(key);
          setAssetChoice('');
        }}
        onAssetChange={setAssetChoice}
        onAmountChange={(value) => {
          setAmount(value);
          setErrorMsg(null);
        }}
        onFindRoute={() => void handleFindRoute()}
        onSelectQuote={handleSelectQuote}
        onFieldChange={(key, value) => setFieldValues((current) => ({ ...current, [key]: value }))}
        onContactContinue={() => {
          if (selected) void startOrder(selected);
        }}
        onSign={() => void handleSign()}
        onApprove={openCosignModal}
        onResumeOrder={(id) => void handleResumeOrder(id)}
        onNewOrder={handleNewOrder}
        onBack={handleBack}
        onRetry={() => {
          setErrorMsg(null);
          setStep('input');
        }}
        onRefresh={() => void handleRefresh()}
        onClose={onClose}
      />
    </div>
  );
}
