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

  // The quorum as this device read it from Turnkey, once per open; a bad
  // reading fails every verification so nothing is approved on it.
  const [quorumFailure, setQuorumFailure] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getClient()
      .cosign.inspectQuorum()
      .then((q) => {
        if (!cancelled && !q.ok) setQuorumFailure(q.reason);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getClient]);

  // Keyed by id: every refresh of the pending list hands back new objects for
  // the same requests, and re-running on those would cancel the check in flight.
  const currentRef = useRef(current);
  currentRef.current = current;
  const currentId = current?.id ?? null;
  useEffect(() => {
    const request = currentRef.current;
    if (!request) return;
    setVerification(null);
    setError(null);
    let cancelled = false;
    getClient()
      .cosign.verify(request)
      .then((v) => {
        if (!cancelled) setVerification(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setVerification({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [currentId, getClient]);

  const run = useCallback(
    async (kind: 'approving' | 'rejecting', request: CosignRequest) => {
      setBusy(kind);
      setError(null);
      try {
        if (kind === 'approving') await getClient().cosign.approve(request);
        else await getClient().cosign.reject(request);
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
        verification={current ? (quorumFailure ? { ok: false, reason: quorumFailure } : verification) : null}
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
