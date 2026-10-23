import React from 'react';
import { ActivityIndicator, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { RampQuote, RampQuoteRejection, RampQuoteRequirement } from '@pollar/core';
import { rampLegTitle, rampRequirementCopy, rampResolutionText, rampTrustlineAsset } from '@pollar/core';

interface RouteDisplayProps {
  quote: RampQuote;
  /** The first quote: the most received (or least sent) for the amount. */
  best?: boolean;
  disabled?: boolean;
  onSelect: (quote: RampQuote) => void;
}

const assetOf = (node: RampQuote['legs'][number]['to']) => (node.kind === 'fiat' ? node.currency : node.code);

export function RouteDisplay({ quote, best = false, disabled = false, onSelect }: RouteDisplayProps) {
  const first = quote.legs[0];
  const last = quote.legs[quote.legs.length - 1];
  return (
    <TouchableOpacity
      style={[styles.card, best && styles.recommended, disabled && { opacity: 0.5 }]}
      disabled={disabled}
      onPress={() => onSelect(quote)}
      activeOpacity={0.7}
    >
      <View style={styles.left}>
        <Text style={styles.provider}>
          {first && last
            ? `${quote.amountIn} ${assetOf(first.from)} → ${quote.amountOut} ${assetOf(last.to)}`
            : quote.amountOut}
        </Text>
        <Text style={styles.meta}>{quote.legs.map((leg) => rampLegTitle(leg)).join(' · ')}</Text>
      </View>
      {best && (
        <View style={styles.right}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Best rate</Text>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

/**
 * A route that was planned and dropped, and what the user can do about it: a
 * verification step opens from its button, a missing trustline is added from its own.
 */
export function RejectedRouteDisplay({
  rejection,
  accentColor = '#005DB4',
  disabled = false,
  trusting = false,
  onVerify,
  onTrust,
}: {
  rejection: RampQuoteRejection;
  accentColor?: string;
  /** A route is starting or a trustline is being added, so nothing else opens meanwhile. */
  disabled?: boolean;
  /** This row's trustline is being added. */
  trusting?: boolean;
  /** Without it, a verification step is described but offers no button. */
  onVerify?: ((requirement: RampQuoteRequirement) => void) | undefined;
  /** Without it, a missing trustline is described but offers no button. */
  onTrust?: ((asset: { code: string; issuer: string }) => void) | undefined;
}) {
  const requirement = rejection.requirement;
  const copy = requirement ? rampRequirementCopy(requirement) : null;
  const trustAsset = !requirement && onTrust ? rampTrustlineAsset(rejection) : null;
  return (
    <View style={[styles.card, !(copy?.action && onVerify) && !trustAsset && { opacity: 0.6 }]}>
      <View style={styles.left}>
        <Text style={styles.provider}>{rejection.legs.map((leg) => rampLegTitle(leg)).join(' · ')}</Text>
        <Text style={styles.meta}>{copy ? copy.message : rampResolutionText(rejection.failure)}</Text>
      </View>
      {trustAsset && (
        <TouchableOpacity
          style={[styles.verify, { borderColor: accentColor, opacity: disabled && !trusting ? 0.5 : 1 }]}
          disabled={disabled}
          accessibilityState={{ busy: trusting, disabled }}
          onPress={() => onTrust!(trustAsset)}
        >
          {trusting ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ActivityIndicator size="small" color={accentColor} />
              <Text style={{ color: accentColor, fontWeight: '600', fontSize: 13 }}>Adding…</Text>
            </View>
          ) : (
            <Text style={{ color: accentColor, fontWeight: '600', fontSize: 13 }}>Add {trustAsset.code} trustline</Text>
          )}
        </TouchableOpacity>
      )}
      {requirement && copy?.action && onVerify && (
        <TouchableOpacity
          style={[styles.verify, { borderColor: accentColor, opacity: disabled ? 0.5 : 1 }]}
          disabled={disabled}
          onPress={() => onVerify(requirement)}
        >
          <Text style={{ color: accentColor, fontWeight: '600', fontSize: 13 }}>{copy.action}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginBottom: 8,
  },
  recommended: {
    borderColor: '#005DB4',
    backgroundColor: '#f0f7ff',
  },
  left: {
    flex: 1,
    gap: 4,
  },
  right: {
    alignItems: 'flex-end',
    marginLeft: 8,
  },
  provider: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  meta: {
    fontSize: 12,
    color: '#6b7280',
  },
  badge: {
    backgroundColor: '#005DB4',
    borderRadius: 9999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  verify: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
  },
});
