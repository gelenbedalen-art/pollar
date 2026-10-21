'use client';

import type { CosignCustody, CustodyMigrationState } from '@pollar/core';
import { useState } from 'react';
import { PollarModalFooter } from '../commons';
import { buildModalCssVars, type ModalStyleOverrides } from '../modal-theme';

export interface CustodyMigrationModalTemplateProps {
  theme: string;
  accentColor: string;
  styleOverrides?: ModalStyleOverrides;
  state: CustodyMigrationState;
  busy: boolean;
  error: string | null;
  onMove: (custody?: CosignCustody) => void;
  onLogout: () => void;
}

const SELF_CUSTODY_RISKS =
  'In a self-custody wallet only your device can sign. If you lose this device and every recovery method, nobody can recover the wallet or its funds, not the app and not Pollar. Nobody can undo or freeze a transaction you sign.';

/**
 * The move of a wallet Pollar custodies to one the user's device signs for.
 * It cannot be put off: the app's wallets live in Turnkey now, so the only
 * ways out are moving or logging out.
 */
export function CustodyMigrationModalTemplate(p: CustodyMigrationModalTemplateProps) {
  const cssVars = buildModalCssVars(p.theme, p.accentColor, p.styleOverrides);
  const [pick, setPick] = useState<CosignCustody | null>(p.state.choice ? null : p.state.toCustody);
  const [risksAccepted, setRisksAccepted] = useState(false);
  const custody = p.state.choice ? pick : p.state.toCustody;
  const canMove = !!custody && (custody !== 'SELF_CUSTODY' || risksAccepted) && !p.busy;

  return (
    <div className="pollar-modal-card pollar-recovery-modal" data-theme={p.theme} style={cssVars}>
      <div className="pollar-modal-header">
        <h2 className="pollar-modal-title">Move your wallet to this device</h2>
      </div>
      <div className="pollar-recovery-body">
        <p className="pollar-recovery-muted">
          Until now Pollar held the key of your wallet. This app now keeps wallets on its users&apos; devices, so the key moves
          here: your address, balance and assets stay exactly the same, and the key Pollar held stops working.
        </p>
        {p.state.choice && (
          <section className="pollar-recovery-section">
            <h3>Choose how your wallet signs</h3>
            <label className="pollar-recovery-check">
              <input type="radio" name="custody" checked={pick === 'COSIGNED'} onChange={() => setPick('COSIGNED')} />{' '}
              Co-signed: you and the app approve every signature together, and the wallet can be recovered with help.
            </label>
            <label className="pollar-recovery-check">
              <input type="radio" name="custody" checked={pick === 'SELF_CUSTODY'} onChange={() => setPick('SELF_CUSTODY')} />{' '}
              Self-custody: only your device signs. Nobody else can move or recover your funds.
            </label>
          </section>
        )}
        {custody === 'SELF_CUSTODY' && (
          <>
            <div className="pollar-recovery-banner pollar-recovery-banner-warn" role="alert">
              {SELF_CUSTODY_RISKS}
            </div>
            <label className="pollar-recovery-check">
              <input type="checkbox" checked={risksAccepted} onChange={(e) => setRisksAccepted(e.target.checked)} /> I
              understand and accept these risks
            </label>
          </>
        )}
        {p.state.status === 'FAILED' && !p.error && (
          <p className="pollar-recovery-error" role="alert">
            The last attempt did not finish. Your wallet is unchanged; try again.
          </p>
        )}
        <button
          type="button"
          className="pollar-recovery-btn pollar-recovery-btn-primary"
          onClick={() => custody && p.onMove(p.state.choice ? custody : undefined)}
          disabled={!canMove}
        >
          {p.busy ? 'Moving your wallet...' : 'Move my wallet'}
        </button>
        <button type="button" className="pollar-recovery-btn pollar-recovery-btn-quiet" onClick={p.onLogout} disabled={p.busy}>
          Log out
        </button>
        {p.error && (
          <p className="pollar-recovery-error" role="alert">
            {p.error}
          </p>
        )}
      </div>
      <PollarModalFooter />
    </div>
  );
}
