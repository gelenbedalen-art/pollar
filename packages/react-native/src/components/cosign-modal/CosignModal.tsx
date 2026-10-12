import type { CosignRequest, CosignVerification } from '@pollar/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePollar } from '../../context';
import { PollarOverlay } from '../commons';
import { CosignModalTemplate } from './CosignModalUI';

interface CosignModalProps {
  onClose: () => void;
}

/**
 * The approval prompt of a Turnkey co-signed wallet. Verifies each request
 * against Turnkey before enabling Approve.
 */
export function CosignModal({ onClose }: CosignModalProps) {
  const { getClient, styles, cosign } = usePollar();
  const { theme = 'light', accentColor = '#005DB4' } = styles;
  const { pending, lastResolved } = cosign;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [verification, setVerification] = useState<CosignVerification | null>(null);
  const [busy, setBusy] = useState<'approving' | 'rejecting' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = pending.find((r) => r.id === selectedId) ?? pending[0] ?? null;

  useEffect(() => {
    void getClient()
      .cosign.pending()
      .catch(() => undefined);
  }, [getClient]);

  const verifiedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!current || verifiedFor.current === current.id) return;
    verifiedFor.current = current.id;
    setVerification(null);
    setError(null);
    let cancelled = false;
    getClient()
      .cosign.verify(current)
      .then((v) => {
        if (!cancelled) setVerification(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setVerification({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [current, getClient]);

  const run = useCallback(
    async (kind: 'approving' | 'rejecting', request: CosignRequest) => {
      setBusy(kind);
      setError(null);
      try {
        if (kind === 'approving') await getClient().cosign.approve(request);
        else await getClient().cosign.reject(request);
        verifiedFor.current = null;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [getClient],
  );

  return (
    <PollarOverlay onCancel={onClose}>
      <CosignModalTemplate
        theme={theme}
        accentColor={accentColor}
        pending={pending}
        current={current}
        verification={current ? verification : null}
        busy={busy}
        error={error}
        {...(lastResolved ? { lastResolved } : {})}
        onSelect={(r) => setSelectedId(r.id)}
        onApprove={(r) => void run('approving', r)}
        onReject={(r) => void run('rejecting', r)}
        onClose={onClose}
      />
    </PollarOverlay>
  );
}
