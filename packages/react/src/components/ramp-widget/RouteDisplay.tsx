'use client';

import type { RampQuote, RampQuoteRejection, RampQuoteRequirement } from '@pollar/core';
import { rampLegTitle, rampRequirementCopy, rampResolutionText, rampTrustlineAsset } from '@pollar/core';

interface RouteDisplayProps {
  quote: RampQuote;
  /** The first quote: the most received (or least sent) for the amount. */
  best?: boolean;
  /** This route is the one being started - it owns the in-flight request. */
  busy?: boolean;
  /** Another route is starting, so this one is not selectable meanwhile. */
  disabled?: boolean;
  onSelect: (quote: RampQuote) => void;
}

const assetOf = (node: RampQuote['legs'][number]['to']) => (node.kind === 'fiat' ? node.currency : node.code);

/** "~3 min" for a route's total; nothing when no leg could estimate it. */
function etaText(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 90) return `~${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.round(seconds / 3600)} h`;
}

export function RouteDisplay({ quote, best = false, busy = false, disabled = false, onSelect }: RouteDisplayProps) {
  const inert = busy || disabled;
  const select = () => {
    if (!inert) onSelect(quote);
  };
  const first = quote.legs[0];
  const last = quote.legs[quote.legs.length - 1];
  return (
    <div
      className="pollar-ramp-route-card"
      data-recommended={best}
      data-busy={busy || undefined}
      data-disabled={disabled || undefined}
      role="button"
      aria-busy={busy}
      aria-disabled={inert}
      tabIndex={inert ? -1 : 0}
      onClick={select}
      onKeyDown={(e) => e.key === 'Enter' && select()}
    >
      <div className="pollar-ramp-route-left">
        <span className="pollar-ramp-route-provider">
          {first && last
            ? `${quote.amountIn} ${assetOf(first.from)} → ${quote.amountOut} ${assetOf(last.to)}`
            : quote.amountOut}
        </span>
        <span className="pollar-ramp-route-meta">
          {busy
            ? 'Starting…'
            : [quote.legs.map((leg) => rampLegTitle(leg)).join(' · '), etaText(quote.etaSeconds)].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="pollar-ramp-route-right">
        {busy ? (
          <span className="pollar-spinner pollar-spinner-sm" />
        ) : (
          <>
            <span className="pollar-ramp-route-fee">
              {quote.legs.length === 1 ? '1 step' : `${quote.legs.length} steps`} · fees included
            </span>
            {best && <span className="pollar-ramp-route-badge">Best rate</span>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A route that was planned and dropped, and what the user can do about it: a
 * verification step opens from its button, a missing trustline is added from its own.
 */
export function RejectedRouteDisplay({
  rejection,
  disabled = false,
  trusting = false,
  creatingWallet = false,
  onVerify,
  onTrust,
  onCreateWallet,
}: {
  rejection: RampQuoteRejection;
  /** A route is starting, a trustline or a wallet is being added, so nothing else opens meanwhile. */
  disabled?: boolean;
  /** This row's trustline is being added. */
  trusting?: boolean;
  /** The user's wallet is being created. */
  creatingWallet?: boolean;
  /** Without it, a verification step is described but offers no button. */
  onVerify?: ((requirement: RampQuoteRequirement) => void) | undefined;
  /** Without it, a missing trustline is described but offers no button. */
  onTrust?: ((asset: { code: string; issuer: string }) => void) | undefined;
  /** Without it (an app that leaves the custody to the user), the wallet is created from the wallet menu. */
  onCreateWallet?: (() => void) | undefined;
}) {
  const requirement = rejection.requirement;
  const copy = requirement ? rampRequirementCopy(requirement) : null;
  const trustAsset = !requirement && onTrust ? rampTrustlineAsset(rejection) : null;
  const toCreate = rejection.failure.resolutionAction === 'create_wallet';
  const meta = copy
    ? copy.message
    : toCreate && !onCreateWallet
      ? 'You need a wallet to receive this. Create it from the wallet menu, then find the route again.'
      : rampResolutionText(rejection.failure);
  const busy = trusting || (toCreate && creatingWallet);
  return (
    <div
      className="pollar-ramp-route-card"
      data-locked
      data-kyc-status={requirement?.status}
      data-disabled={
        (!(copy?.action && onVerify) && !trustAsset && !(toCreate && onCreateWallet)) || (disabled && !busy) || undefined
      }
    >
      <div className="pollar-ramp-route-left">
        <span className="pollar-ramp-route-provider">{rejection.legs.map((leg) => rampLegTitle(leg)).join(' · ')}</span>
        <span className="pollar-ramp-route-meta">{meta}</span>
      </div>
      {trustAsset && (
        <div className="pollar-ramp-route-right">
          <button
            type="button"
            className="pollar-btn-secondary pollar-ramp-route-verify"
            disabled={disabled}
            aria-busy={trusting}
            onClick={() => onTrust!(trustAsset)}
          >
            {trusting ? (
              <>
                <span className="pollar-spinner pollar-spinner-sm" /> Adding…
              </>
            ) : (
              `Add ${trustAsset.code} trustline`
            )}
          </button>
        </div>
      )}
      {toCreate && onCreateWallet && (
        <div className="pollar-ramp-route-right">
          <button
            type="button"
            className="pollar-btn-secondary pollar-ramp-route-verify"
            disabled={disabled}
            aria-busy={creatingWallet}
            onClick={onCreateWallet}
          >
            {creatingWallet ? (
              <>
                <span className="pollar-spinner pollar-spinner-sm" /> Creating…
              </>
            ) : (
              'Create wallet'
            )}
          </button>
        </div>
      )}
      {requirement && copy?.action && onVerify && (
        <div className="pollar-ramp-route-right">
          <button
            type="button"
            className="pollar-btn-secondary pollar-ramp-route-verify"
            disabled={disabled}
            onClick={() => onVerify(requirement)}
          >
            {copy.action}
          </button>
        </div>
      )}
    </div>
  );
}
