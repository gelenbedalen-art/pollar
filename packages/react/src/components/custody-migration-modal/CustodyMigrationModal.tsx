'use client';

import { type CosignCustody, type CustodyMigrationState, isPollarApiError, transactionErrorMessage } from '@pollar/core';
import { useState } from 'react';
import { usePollar } from '../../context';
import '../shared.css';
import '../recovery-modal/RecoveryModal.css';
import { modalChrome } from '../modal-theme';
import { CustodyMigrationModalTemplate } from './CustodyMigrationModalTemplate';

interface CustodyMigrationModalProps {
  state: CustodyMigrationState;
  /** The wallet moved: the provider reads its state again and asks for a recovery method. */
  onMoved: () => void;
}

export function CustodyMigrationModal({ state, onMoved }: CustodyMigrationModalProps) {
  const { getClient, styles } = usePollar();
  const { theme, accentColor, styleOverrides, overlayStyle } = modalChrome(styles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(custody?: CosignCustody) {
    setBusy(true);
    setError(null);
    try {
      await getClient().cosign.migrateWallet(custody);
      onMoved();
    } catch (err) {
      setError(transactionErrorMessage(isPollarApiError(err) ? err.code : null, err instanceof Error ? err.message : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pollar-overlay" style={overlayStyle}>
      <CustodyMigrationModalTemplate
        theme={theme}
        accentColor={accentColor}
        styleOverrides={styleOverrides}
        state={state}
        busy={busy}
        error={error}
        onMove={(custody) => void move(custody)}
        onLogout={() => void getClient().logout()}
      />
    </div>
  );
}
