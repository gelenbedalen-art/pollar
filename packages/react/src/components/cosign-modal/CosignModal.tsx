'use client';

import type { CosignRequest, CosignVerification } from '@pollar/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePollar } from '../../context';
import { useCosign } from '../../useCosign';
import '../shared.css';
import './CosignModal.css';
import { CosignModalTemplate } from './CosignModalTemplate';
import { modalChrome } from '../modal-theme';

interface CosignModalProps {
  onClose: () => void;
}

/**
 * The approval prompt of a Turnkey co-signed wallet. Verifies each request
 * against Turnkey before enabling Approve, so the user only ever confirms a
 * transaction the device checked itself.
 */
export function CosignModal({ onClose }: CosignModalProps) {
  const { getClient, styles } = usePollar();
  const { theme, accentColor, styleOverrides, overlayStyle } = modalChrome(styles);
  const { pending, lastResolved, approve, reject, verify, inspectQuorum } = useCosign();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [verification, setVerification] = useState<CosignVerification | null>(null);
  const [busy, setBusy] = useState<'approving' | 'rejecting' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The quorum as this device read it from Turnkey, once per open. Approving
  // anything on a sub-organization that is not the promised 2-of-2 would be a
  // vote on a wallet someone else can also control, so a bad reading fails
  // every verification below.
  const [quorumFailure, setQuorumFailure] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    inspectQuorum()
      .then((q) => {
        if (!cancelled && !q.ok) setQuorumFailure(q.reason);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [inspectQuorum]);

  const current = pending.find((r) => r.id === selectedId) ?? pending[0] ?? null;

  // Verify whenever the shown request changes; a stale result must never
  // enable Approve for a different request. Keyed by id: every refresh of the
  // pending list hands back new objects for the same requests, and re-running
  // on those would cancel the check in flight.
  const currentRef = useRef(current);
  currentRef.current = current;
  const currentId = current?.id ?? null;
  useEffect(() => {
    const request = currentRef.current;
    if (!request) return;
    setVerification(null);
    setError(null);
    let cancelled = false;
    verify(request)
      .then((v) => {
        if (!cancelled) setVerification(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setVerification({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [currentId, verify]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    return getClient().onAuthStateChange((authState) => {
      if (authState.step === 'idle') onCloseRef.current();
    });
  }, [getClient]);

  const run = useCallback(
    async (kind: 'approving' | 'rejecting', request: CosignRequest, action: (r: CosignRequest) => Promise<CosignRequest>) => {
      setBusy(kind);
      setError(null);
      try {
        await action(request);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return (
    <div className="pollar-overlay" style={overlayStyle} onClick={onClose}>
      <CosignModalTemplate
        theme={theme}
        accentColor={accentColor}
        styleOverrides={styleOverrides}
        pending={pending}
        current={current}
        verification={current ? (quorumFailure ? { ok: false, reason: quorumFailure } : verification) : null}
        busy={busy}
        error={error}
        {...(lastResolved ? { lastResolved } : {})}
        onSelect={(r) => setSelectedId(r.id)}
        onApprove={(r) => void run('approving', r, approve)}
        onReject={(r) => void run('rejecting', r, reject)}
        onClose={onClose}
      />
    </div>
  );
}
