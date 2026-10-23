import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Linking,
  Image,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SvgXml } from 'react-native-svg';
import type {
  PollarClient,
  RampAsset,
  RampSigningHandler,
  RampDirection,
  RampField,
  RampFiat,
  RampOrder,
  RampQuote,
  RampQuoteRejection,
  RampQuoteRequirement,
  RampRoute,
} from '@pollar/core';
import {
  appUnavailableMessage,
  assertRampStellarSigner,
  describeRampAction,
  isPollarApiError,
  rampCountries,
  rampLegStatus,
  rampLegTitle,
  rampFieldValid,
  rampNoRouteText,
  rampOrderReceive,
  rampOrderStopped,
  rampQuoteFields,
  rampRailLabel,
  rampResolutionText,
  rampTrustlineAsset,
  rampTrustlineErrorText,
} from '@pollar/core';
import { usePollar } from '../../context';
import { PollarOverlay } from '../commons';
import { formLanguage } from '../requirement-form-modal/form-fields';
import { RejectedRouteDisplay, RouteDisplay } from './RouteDisplay';
import { KycModal } from '../kyc-modal/KycModal';
import { RequirementFormModal } from '../requirement-form-modal/RequirementFormModal';
import { RegistryCheckModal } from '../registry-check-modal/RegistryCheckModal';
import { ProviderRegistrationModal } from '../provider-registration-modal/ProviderRegistrationModal';

export type RampStep = 'input' | 'loading_quote' | 'select_route' | 'contact' | 'status' | 'error';

/** The trustline a dropped route asks for, as the widget tracks it while it is added. */
function trustKey(rejection: RampQuoteRejection): string | null {
  const asset = rampTrustlineAsset(rejection);
  return asset ? `${asset.code}:${asset.issuer}` : null;
}

/** Ramp failures a user can act on, by API code. */
const RAMP_ERROR_MESSAGES: Record<string, string> = {
  SDK_RAMPS_QUOTE_EXPIRED: 'This quote expired. Find a route again.',
  SDK_RAMPS_QUOTE_NOT_FOUND: 'This quote is no longer available. Find a route again.',
  SDK_RAMPS_ACTION_STALE: 'This step changed. It was refreshed; try again.',
  SDK_RAMPS_TX_NOT_FOUND: 'This operation was not found.',
  SDK_RAMPS_WALLET_NOT_READY: 'Approve the new wallet account on your device, then try again.',
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
const CHAIN_NAME: Record<string, string> = { STELLAR: 'Stellar', POLYGON: 'Polygon', SOLANA: 'Solana' };
const fiatKey = (fiat: Pick<RampFiat, 'currency' | 'rail'>) => `${fiat.currency}:${fiat.rail}`;
const assetKey = (asset: Pick<RampAsset, 'code' | 'chain' | 'identifier'>) =>
  `${asset.code}:${asset.chain}:${asset.identifier ?? ''}`;

export interface RampWidgetTemplateProps {
  theme?: string;
  accentColor?: string;
  step: RampStep;
  direction: RampDirection;
  routesLoading: boolean;
  countries: Array<{ country: string; fiats: RampFiat[] }>;
  country: string;
  fiats: RampFiat[];
  fiat: RampFiat | null;
  assets: RampAsset[];
  asset: RampAsset | null;
  amount: string;
  quotes: RampQuote[];
  rejected: RampQuoteRejection[];
  startingQuoteId: string | null;
  fields: RampField[];
  fieldValues: Record<string, string>;
  order: RampOrder | null;
  pendingOrders: RampOrder[];
  isLoading: boolean;
  signing: boolean;
  errorMsg: string | null;
  onDirectionChange: (direction: RampDirection) => void;
  onCountryChange: (country: string) => void;
  onFiatChange: (key: string) => void;
  onAssetChange: (key: string) => void;
  onAmountChange: (value: string) => void;
  onFindRoute: () => void;
  onSelectQuote: (quote: RampQuote) => void;
  /** Opens the verification step a dropped route waits on. */
  onVerifyRoute?: (requirement: RampQuoteRequirement) => void;
  /** The Stellar asset whose trustline is being added, as `code:issuer`; null when none is. */
  trustingAsset?: string | null;
  /** Adds the trustline a dropped route needs, then quotes again. */
  onTrustAsset?: (asset: { code: string; issuer: string }) => void;
  /** The user's wallet is being created. */
  creatingWallet?: boolean;
  /** Creates the user's wallet a dropped route needs, then quotes again; absent, the row points to the wallet menu. */
  onCreateWallet?: (() => void) | undefined;
  /** The app serves no chain, so it has nothing to buy or sell. */
  noChains?: boolean;
  /** A held order the user resolves is being run again. */
  retrying?: boolean;
  /** Runs the user's held order again; absent, a held order only says what happened. */
  onRetryOrder?: (() => void) | undefined;
  /** Reading the order keeps failing and polling is retrying. */
  pollTrouble?: boolean;
  onFieldChange: (key: string, value: string) => void;
  onContactContinue: () => void;
  onSign: () => void;
  onApprove: () => void;
  onCopy: (text: string) => void;
  onResumeOrder: (id: string) => void;
  onNewOrder: () => void;
  onBack: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function RampWidgetTemplate({
  theme = 'light',
  accentColor = '#005DB4',
  step,
  direction,
  routesLoading,
  countries,
  country,
  fiats,
  fiat,
  assets,
  asset,
  amount,
  quotes,
  rejected,
  startingQuoteId,
  fields,
  fieldValues,
  order,
  pendingOrders,
  isLoading,
  signing,
  errorMsg,
  onDirectionChange,
  onCountryChange,
  onFiatChange,
  onAssetChange,
  onAmountChange,
  onFindRoute,
  onSelectQuote,
  onVerifyRoute,
  trustingAsset = null,
  onTrustAsset,
  creatingWallet = false,
  onCreateWallet,
  noChains = false,
  retrying = false,
  onRetryOrder,
  pollTrouble = false,
  onFieldChange,
  onContactContinue,
  onSign,
  onApprove,
  onCopy,
  onResumeOrder,
  onNewOrder,
  onBack,
  onRetry,
  onClose,
}: RampWidgetTemplateProps) {
  const isDark = theme === 'dark';
  const colors = {
    bg: isDark ? '#1a1a1a' : '#ffffff',
    border: isDark ? '#374151' : '#e5e7eb',
    text: isDark ? '#ffffff' : '#111827',
    muted: isDark ? '#9ca3af' : '#6b7280',
    inputBg: isDark ? '#374151' : '#f9fafb',
    error: '#ef4444',
  };
  const onramp = direction === 'ONRAMP';
  const view = order ? describeRampAction(order) : null;
  const settled = order ? ['completed', 'failed', 'refunded'].includes(order.state) : false;
  // Held (no next read) or final: the order no longer moves on its own.
  const stopped = order ? rampOrderStopped(order) : false;
  const receive = order ? rampOrderReceive(order) : null;
  const missingField = fields.some((f) => !rampFieldValid(f, fieldValues[f.key]));
  const canFind = !!amount && Number(amount) > 0 && !!fiat && !!asset && !isLoading;

  const primary = (label: string, onPress: () => void, disabled = false) => (
    <TouchableOpacity
      style={[styles.primaryBtn, { backgroundColor: accentColor, opacity: disabled ? 0.5 : 1 }]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
  const secondary = (label: string, onPress: () => void, disabled = false) => (
    <TouchableOpacity
      style={[styles.secondaryBtn, { borderColor: colors.border, opacity: disabled ? 0.5 : 1 }]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={{ color: colors.text, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
  const chips = <T extends string>(items: Array<{ key: T; label: string }>, selected: string, onPick: (key: T) => void) => (
    <View style={[styles.row, { flexWrap: 'wrap' }]}>
      {items.map((item) => (
        <TouchableOpacity
          key={item.key}
          style={[styles.chip, { borderColor: item.key === selected ? accentColor : colors.border }]}
          onPress={() => onPick(item.key)}
        >
          <Text style={{ color: colors.text }}>{item.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
  const copyRow = (label: string, value: string) => (
    <View key={label} style={[styles.instructions, { borderColor: colors.border }]}>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text }} selectable>
        {value}
      </Text>
      <TouchableOpacity onPress={() => onCopy(value)} accessibilityLabel={`Copy ${label}`}>
        <Text style={{ color: accentColor, fontWeight: '600', marginTop: 4 }}>Copy</Text>
      </TouchableOpacity>
    </View>
  );
  const errorLine = errorMsg ? <Text style={[styles.note, { color: colors.error }]}>{errorMsg}</Text> : null;
  const scannable = view?.scannable ?? null;

  return (
    <View style={[styles.card, { backgroundColor: colors.bg, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>{onramp ? 'Add funds' : 'Cash out'}</Text>
      </View>

      <TouchableOpacity
        style={[styles.iconButton, styles.closeBtn, { borderColor: colors.border }]}
        onPress={onClose}
        accessibilityLabel="Close"
      >
        <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
      </TouchableOpacity>

      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {step === 'input' && (
          <>
            {pendingOrders.length > 0 && (
              <>
                <Text style={[styles.note, { color: colors.muted }]}>These operations are waiting for you:</Text>
                {pendingOrders.map((pending) =>
                  secondary(
                    `Resume ${pending.direction === 'ONRAMP' ? 'purchase' : 'sale'} · ${pending.id.slice(-8)}`,
                    () => onResumeOrder(pending.id),
                    isLoading,
                  ),
                )}
              </>
            )}
            {chips<RampDirection>(
              [
                { key: 'ONRAMP', label: 'Buy' },
                { key: 'OFFRAMP', label: 'Sell' },
              ],
              direction,
              onDirectionChange,
            )}
            {routesLoading ? (
              <ActivityIndicator color={accentColor} style={{ marginBottom: 16 }} />
            ) : countries.length === 0 ? (
              <Text style={[styles.note, { color: colors.muted }]}>
                {noChains
                  ? 'This app has no chains enabled, so there is nothing to buy or sell yet.'
                  : 'No ramp routes are available for this app yet.'}
              </Text>
            ) : (
              <>
                <Text style={[styles.label, { color: colors.text }]}>Country</Text>
                {chips(
                  countries.map((c) => ({ key: c.country, label: c.country })),
                  country,
                  onCountryChange,
                )}
                {fiats.length > 1 && (
                  <>
                    <Text style={[styles.label, { color: colors.text }]}>{onramp ? 'Pay with' : 'Receive in'}</Text>
                    {chips(
                      fiats.map((f) => ({
                        key: fiatKey(f),
                        label: `${f.currency} · ${rampRailLabel(f.rail, { language: formLanguage() })}`,
                      })),
                      fiat ? fiatKey(fiat) : '',
                      onFiatChange,
                    )}
                  </>
                )}
                <Text style={[styles.label, { color: colors.text }]}>{onramp ? 'Receive' : 'Sell'}</Text>
                {chips(
                  assets.map((a) => ({ key: assetKey(a), label: `${a.code} on ${CHAIN_NAME[a.chain] ?? a.chain}` })),
                  asset ? assetKey(asset) : '',
                  onAssetChange,
                )}
              </>
            )}
            <Text style={[styles.label, { color: colors.text }]}>
              {onramp ? 'You pay' : 'You sell'}
              {(onramp ? fiat?.currency : asset?.code) ? ` (${onramp ? fiat?.currency : asset?.code})` : ''}
            </Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
              placeholder="25.00"
              placeholderTextColor={colors.muted}
              keyboardType="decimal-pad"
              value={amount}
              onChangeText={onAmountChange}
            />
            {errorLine}
            {primary('Find routes', onFindRoute, !canFind)}
          </>
        )}

        {step === 'loading_quote' && (
          <View style={styles.statusBox}>
            <ActivityIndicator size="large" color={accentColor} />
            <Text style={{ color: colors.text, marginTop: 16 }}>Finding routes…</Text>
          </View>
        )}

        {step === 'select_route' && (
          <>
            {quotes.map((q, i) => (
              <RouteDisplay
                key={q.quoteId}
                quote={q}
                best={i === 0}
                disabled={startingQuoteId != null}
                onSelect={onSelectQuote}
              />
            ))}
            {rejected.map((r, i) => (
              <RejectedRouteDisplay
                key={i}
                rejection={r}
                accentColor={accentColor}
                disabled={startingQuoteId != null || trustingAsset !== null || creatingWallet}
                trusting={trustKey(r) === trustingAsset}
                creatingWallet={creatingWallet}
                onVerify={onVerifyRoute}
                onTrust={onTrustAsset}
                onCreateWallet={onCreateWallet}
              />
            ))}
            {quotes.length === 0 && <Text style={[styles.note, { color: colors.muted }]}>{rampNoRouteText(rejected)}</Text>}
            {startingQuoteId && <ActivityIndicator color={accentColor} />}
            {errorLine}
            {secondary('Back', onBack)}
          </>
        )}

        {step === 'contact' && (
          <>
            {fields.map((f) => (
              <View key={f.key}>
                <Text style={[styles.label, { color: colors.text }]}>
                  {f.label}
                  {f.optional ? ' (optional)' : ''}
                </Text>
                {f.type === 'select' && f.options ? (
                  chips(
                    f.options.map((o) => ({ key: o.value, label: o.label })),
                    fieldValues[f.key] ?? '',
                    (value) => onFieldChange(f.key, value),
                  )
                ) : (
                  <TextInput
                    style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                    placeholder={f.placeholder ?? ''}
                    placeholderTextColor={colors.muted}
                    keyboardType={f.type === 'email' ? 'email-address' : f.type === 'tel' ? 'phone-pad' : 'default'}
                    autoCapitalize="none"
                    value={fieldValues[f.key] ?? ''}
                    onChangeText={(value) => onFieldChange(f.key, value)}
                  />
                )}
                {f.hint ? <Text style={[styles.note, { color: colors.muted }]}>{f.hint}</Text> : null}
              </View>
            ))}
            {errorLine}
            {primary(isLoading ? 'Starting…' : 'Continue', onContactContinue, missingField || isLoading)}
            {secondary('Back', onBack)}
          </>
        )}

        {step === 'status' && order && view && (
          <>
            <Text style={[styles.label, { color: colors.text }]}>{view.title}</Text>
            {order.legs.map((leg) => {
              const status = rampLegStatus(leg);
              return (
                <View key={leg.index} style={[styles.row, { alignItems: 'center', marginBottom: 6 }]}>
                  <View
                    style={[
                      styles.legDot,
                      {
                        borderColor: status === 'failed' ? colors.error : status === 'pending' ? colors.border : accentColor,
                        backgroundColor: status === 'done' ? accentColor : 'transparent',
                      },
                    ]}
                  />
                  <Text
                    style={{
                      flex: 1,
                      color: status === 'failed' ? colors.error : status === 'pending' ? colors.muted : colors.text,
                    }}
                  >
                    {rampLegTitle(leg)}
                  </Text>
                  {status === 'active' && !settled && <ActivityIndicator size="small" color={accentColor} />}
                </View>
              );
            })}

            {receive &&
              copyRow(order.state === 'completed' ? 'You received' : 'You receive', `${receive.amount} ${receive.unit}`)}
            {order.failure && (
              <>
                <Text style={[styles.note, { color: colors.text }]}>{rampResolutionText(order.failure)}</Text>
                {copyRow('Order', order.id)}
                {stopped &&
                  !settled &&
                  order.failure.resolutionOwner === 'END_USER' &&
                  onRetryOrder &&
                  primary(retrying ? 'Trying again…' : 'Try again', onRetryOrder, retrying)}
              </>
            )}
            {!settled && view.action?.kind === 'FIAT_PAYMENT' && view.expiresAt && (
              <Text style={[styles.note, { color: colors.muted }]}>
                {Date.parse(view.expiresAt) > Date.now()
                  ? `Pay before ${new Date(view.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                  : 'This payment window has closed. If you have not paid, start a new operation.'}
              </Text>
            )}

            {!settled && scannable && (
              <View style={{ alignItems: 'center', marginVertical: 12 }}>
                {scannable.payload ? (
                  <QRCode value={scannable.payload} size={200} />
                ) : scannable.image.mediaType === 'image/svg+xml' ? (
                  <SvgXml xml={scannable.image.data} width={200} height={200} color={colors.text} />
                ) : (
                  <Image
                    source={{ uri: `data:${scannable.image.mediaType};base64,${scannable.image.data}` }}
                    style={{ width: 200, height: 200 }}
                    accessibilityLabel="Payment QR"
                  />
                )}
              </View>
            )}
            {!settled && scannable?.payload && scannable.payloadLabel && copyRow(scannable.payloadLabel, scannable.payload)}
            {!settled && view.details.map((d) => copyRow(d.label, d.value))}

            {!settled && view.canSign && primary(signing ? 'Waiting for your wallet…' : 'Authorize', onSign, signing)}
            {!settled && view.action?.kind === 'SIGNATURE' && !view.canSign && (
              <Text style={[styles.note, { color: colors.muted }]}>Preparing a new signature request…</Text>
            )}
            {!settled && view.canApprove && primary('Approve on this device', onApprove)}
            {!settled && view.link && primary('Complete verification', () => void Linking.openURL(view.link!))}
            {!settled && order.pendingAction?.kind === 'KYC' && !view.link && (
              <Text style={[styles.note, { color: colors.muted }]}>
                The provider is reviewing your details. This updates on its own.
              </Text>
            )}
            {pollTrouble && !settled && (
              <Text style={[styles.note, { color: colors.muted }]}>Having trouble reaching the server. Retrying…</Text>
            )}
            {errorLine}
            {secondary('Start another operation', onNewOrder)}
          </>
        )}

        {step === 'error' && (
          <>
            {errorLine}
            {primary('Try again', onRetry)}
            {secondary('Close', onClose)}
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function RampWidget({ onClose }: { onClose: () => void }) {
  const { getClient, copyText, ramp: saved, setRamp: save, styles: pollarStyles, openCosignModal, appConfig } = usePollar();
  const { theme = 'light', accentColor = '#005DB4' } = pollarStyles;
  const client = getClient();

  const [step, setStep] = useState<RampStep>(saved ? 'status' : 'input');
  const [direction, setDirection] = useState<RampDirection>(saved?.direction ?? 'ONRAMP');
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
  const [order, setOrderState] = useState<RampOrder | null>(saved?.order ?? null);
  const [pendingOrders, setPendingOrders] = useState<RampOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<RampQuoteRequirement | null>(null);
  const [trustingAsset, setTrustingAsset] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // A read of the order failed and polling keeps trying; cleared by the next good read.
  const [pollTrouble, setPollTrouble] = useState(false);
  // Bumped to start following the order again (after a retry of one that had stopped).
  const [pollKey, setPollKey] = useState(0);
  // The approval the user was last prompted for, so each new one prompts once.
  const promptedApproval = useRef<string | null>(null);
  // An app that leaves the custody to the user creates the wallet from the wallet menu, where the user picks it.
  const custodyChoice = appConfig.application?.walletCustodyMode === 'USER_CHOICE';
  const appChains = appConfig.application?.chains;
  // The step opened last: a modal that reports after it was closed or replaced is ignored.
  const verifyAttempt = useRef<RampQuoteRequirement | null>(null);

  // The provider keeps the order so closing and reopening the widget lands back on it.
  const setOrder = (next: RampOrder | null) => {
    setOrderState(next);
    save(next ? { direction: next.direction, order: next } : null);
  };

  const countries = useMemo(() => rampCountries(routes), [routes]);
  const fiats = countries.find((c) => c.country === country)?.fiats ?? [];
  const fiat = fiats.find((f) => fiatKey(f) === fiatChoice) ?? fiats[0] ?? null;
  const assets = useMemo(() => {
    const seen = new Map<string, RampAsset>();
    for (const route of routes)
      if (fiat && route.fiat.country === country && fiatKey(route.fiat) === fiatKey(fiat))
        seen.set(assetKey(route.asset), route.asset);
    return [...seen.values()];
  }, [routes, country, fiat]);
  const asset = assets.find((a) => assetKey(a) === assetChoice) ?? assets[0] ?? null;
  const fields = selected ? rampQuoteFields(selected) : [];

  useEffect(() => {
    let active = true;
    setRoutesLoading(true);
    client
      .getRampRoutes(direction)
      .then(({ routes: found }) => {
        if (!active) return;
        setRoutes(found);
        const first = rampCountries(found)[0]?.country ?? '';
        setCountry((current) => (found.some((r) => r.fiat.country === current) ? current : first));
      })
      .catch((error) => {
        if (active) setErrorMsg(rampErrorMessage(error, 'Could not load the ramp routes.'));
      })
      .finally(() => {
        if (active) setRoutesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, direction]);

  useEffect(() => {
    let active = true;
    client
      // Every order not final yet: one already paid and moving on its own is still the user's to follow.
      .listRampOrders({ open: 'true', limit: 5 })
      .then((page) => {
        if (active) setPendingOrders(page.orders);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client, step]);

  // Follow the order at the pace the server suggests until it settles. Reading never signs or approves.
  const orderId = order?.id ?? null;
  useEffect(() => {
    if (step !== 'status' || !orderId) return;
    const controller = new AbortController();
    client
      .pollRampOrder(orderId, {
        signal: controller.signal,
        onUpdate: (next) => {
          setOrder(next);
          setPollTrouble(false);
        },
        onError: () => setPollTrouble(true),
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setErrorMsg(rampErrorMessage(error, 'This operation could not be read.'));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, step, orderId, pollKey]);

  // A co-signed step of the order waits on the user's device: bring its request up the moment it appears.
  const approval = order?.pendingAction?.kind === 'COSIGN_APPROVAL' ? order.pendingAction.actionId : null;
  useEffect(() => {
    if (!approval || promptedApproval.current === approval) return;
    promptedApproval.current = approval;
    void client.cosign
      .pending()
      .catch(() => undefined)
      .then(() => openCosignModal());
  }, [approval, client, openCosignModal]);

  /** Runs the user's held order again, then follows it. */
  async function handleRetryOrder() {
    if (!order || retrying) return;
    setRetrying(true);
    setErrorMsg(null);
    try {
      setOrder(await client.retryRampOrder(order.id));
      setPollKey((key) => key + 1);
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, 'Could not try again. Please try again.'));
    } finally {
      setRetrying(false);
    }
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

  function handleVerifyRoute(requirement: RampQuoteRequirement) {
    setErrorMsg(null);
    verifyAttempt.current = requirement;
    setVerifying(requirement);
  }

  function closeVerification() {
    verifyAttempt.current = null;
    setVerifying(null);
  }

  /** A completed step can unlock its route: quote again with the same amount. */
  function verificationDone(requirement: RampQuoteRequirement) {
    if (verifyAttempt.current !== requirement) return;
    closeVerification();
    void handleFindRoute();
  }

  /** Adds the trustline a dropped route needs, sponsored when the app covers it, then quotes again. */
  async function handleTrustAsset(asset: { code: string; issuer: string }) {
    if (trustingAsset) return;
    setTrustingAsset(`${asset.code}:${asset.issuer}`);
    setErrorMsg(null);
    try {
      const outcome = await client.setTrustline(asset);
      if (outcome.status === 'error') {
        setErrorMsg(rampTrustlineErrorText(outcome, asset.code));
        return;
      }
      if (outcome.status === 'cosign_pending') {
        setErrorMsg(`Approve the ${asset.code} trustline, then refresh the routes.`);
        openCosignModal();
        return;
      }
      await client.refreshAssets().catch(() => {});
      await handleFindRoute();
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, `Could not add the ${asset.code} trustline. Please try again.`));
    } finally {
      setTrustingAsset(null);
    }
  }

  /** Creates the user's wallet on the app's chains, then quotes again. */
  async function handleCreateWallet() {
    if (creatingWallet) return;
    setCreatingWallet(true);
    setErrorMsg(null);
    try {
      await client.createWallet();
      await handleFindRoute();
    } catch (error) {
      setErrorMsg(
        isPollarApiError(error) && error.code === 'SDK_WALLET_PROVISIONING_DISABLED'
          ? 'This app does not create wallets.'
          : rampErrorMessage(error, 'Could not create the wallet. Please try again.'),
      );
    } finally {
      setCreatingWallet(false);
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
      setOrder(await client.createRampOrder({ quoteId: quote.quoteId, ...(Object.keys(payee).length ? { payee } : {}) }));
      setStep('status');
    } catch (error) {
      setErrorMsg(rampErrorMessage(error, 'Could not start the operation. Please try again.'));
      // The route's wallet on another chain waits on the user's approval: bring that request up.
      if (isPollarApiError(error) && error.code === 'SDK_RAMPS_WALLET_NOT_READY')
        void client.cosign
          .pending()
          .catch(() => undefined)
          .then(() => openCosignModal());
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

  // The step replaces the widget while it is open; the widget keeps what was entered.
  if (verifying) {
    const progress = { position: verifying.completed + 1, total: verifying.total };
    const done = () => verificationDone(verifying);
    if (verifying.type === 'FORM')
      return (
        <RequirementFormModal formId={verifying.optionId} progress={progress} onClose={closeVerification} onSubmitted={done} />
      );
    if (verifying.type === 'REGISTRY_CHECK')
      return (
        <RegistryCheckModal optionId={verifying.optionId} progress={progress} onClose={closeVerification} onApproved={done} />
      );
    if (verifying.type === 'PROVIDER_REGISTRATION')
      return (
        <ProviderRegistrationModal
          corridorId={verifying.corridorId}
          progress={progress}
          onClose={closeVerification}
          onRegistered={done}
        />
      );
    return (
      <KycModal
        country={country}
        corridorId={verifying.corridorId}
        providerId={verifying.optionId}
        onClose={closeVerification}
        onApproved={done}
      />
    );
  }

  return (
    <PollarOverlay onCancel={onClose}>
      <View style={styles.modalWrapper}>
        <RampWidgetTemplate
          theme={theme}
          accentColor={accentColor}
          step={step}
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
          signing={signing}
          errorMsg={errorMsg}
          onDirectionChange={(next) => {
            setDirection(next);
            setErrorMsg(null);
          }}
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
          onAmountChange={(next) => {
            setAmount(next);
            setErrorMsg(null);
          }}
          onFindRoute={() => void handleFindRoute()}
          onSelectQuote={handleSelectQuote}
          onVerifyRoute={handleVerifyRoute}
          trustingAsset={trustingAsset}
          onTrustAsset={(asset) => void handleTrustAsset(asset)}
          creatingWallet={creatingWallet}
          onCreateWallet={custodyChoice ? undefined : () => void handleCreateWallet()}
          noChains={Array.isArray(appChains) && appChains.length === 0}
          retrying={retrying}
          onRetryOrder={() => void handleRetryOrder()}
          pollTrouble={pollTrouble}
          onFieldChange={(key, value) => setFieldValues((current) => ({ ...current, [key]: value }))}
          onContactContinue={() => {
            if (selected) void startOrder(selected);
          }}
          onSign={() => void handleSign()}
          onApprove={openCosignModal}
          onCopy={(text) =>
            void copyText(text).catch((error: unknown) => setErrorMsg(rampErrorMessage(error, 'Could not copy.')))
          }
          onResumeOrder={(id) => void handleResumeOrder(id)}
          onNewOrder={() => {
            setOrder(null);
            setSelected(null);
            setQuotes([]);
            setRejected([]);
            setErrorMsg(null);
            setStep('input');
          }}
          onBack={() => {
            setErrorMsg(null);
            setStep(step === 'contact' ? 'select_route' : 'input');
          }}
          onRetry={() => {
            setErrorMsg(null);
            setStep('input');
          }}
          onClose={onClose}
        />
      </View>
    </PollarOverlay>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 50,
  },
  modalWrapper: {
    width: '100%',
    maxWidth: 400,
  },
  card: {
    width: '100%',
    maxHeight: '90%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  header: {
    marginBottom: 16,
    marginTop: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  iconButton: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  closeBtn: {
    top: 16,
    right: 16,
  },
  body: {
    marginVertical: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 9999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  note: {
    fontSize: 14,
    lineHeight: 20,
    marginVertical: 8,
  },
  input: {
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 8,
  },
  instructions: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  primaryBtn: {
    width: '100%',
    height: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryBtn: {
    width: '100%',
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  legDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
  statusBox: {
    paddingVertical: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
