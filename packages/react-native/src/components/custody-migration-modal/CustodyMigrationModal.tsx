import { type CosignCustody, type CustodyMigrationState, isPollarApiError, transactionErrorMessage } from '@pollar/core';
import React, { useState } from 'react';
import { usePollar } from '../../context';
import { PollarOverlay } from '../commons';
import { CustodyMigrationModalTemplate } from './CustodyMigrationModalUI';

interface CustodyMigrationModalProps {
  state: CustodyMigrationState;
  /** The wallet moved: the provider reads its state again and asks for a recovery method. */
  onMoved: () => void;
}

export function CustodyMigrationModal({ state, onMoved }: CustodyMigrationModalProps) {
  const { getClient, styles, logout } = usePollar();
  const { theme = 'light', accentColor = '#005DB4' } = styles;
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
    <PollarOverlay onCancel={() => undefined}>
      <CustodyMigrationModalTemplate
        theme={theme}
        accentColor={accentColor}
        state={state}
        busy={busy}
        error={error}
        onMove={(custody) => void move(custody)}
        onLogout={() => void logout()}
      />
    </PollarOverlay>
  );
}
