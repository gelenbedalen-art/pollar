'use client';
import { describeRampAction, type PollarClient, type RampSnapshot, type RampsTransactionResponse } from '@pollar/core';
import { QRCode } from '../../lib/qr-code';
import { useState, useRef, useEffect } from 'react';
export function RampWorkflow({
  client,
  snapshot,
  onChange,
  onBusyChange,
}: {
  client: PollarClient;
  snapshot: RampSnapshot;
  onChange: (next: RampsTransactionResponse) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const model = describeRampAction(snapshot);
  const locked = useRef(false);
  useEffect(() => {
    setFields({});
    setError(null);
  }, [model.action?.actionId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const fieldsComplete =
    model.action?.kind !== 'collect_information' ||
    model.action.fields.every((field) => {
      const value = (fields[field.key] ?? '').trim();
      if (!value) return field.optional;
      if (field.type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      return field.type !== 'select' || field.options?.some((option) => option.value === value);
    });
  async function continueAction() {
    if (!model.action || locked.current || !fieldsComplete) return;
    locked.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      onChange(
        model.canSign
          ? await client.signRampAction(snapshot.txId, snapshot)
          : await client.continueRamp(snapshot.txId, {
              actionId: model.action.actionId,
              transactionVersion: snapshot.transactionVersion!,
              ...(model.action.kind === 'collect_information' ? { fields } : {}),
            }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to continue.');
    } finally {
      locked.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <section
      className="pollar-ramp-payment pollar-ramp-workflow"
      aria-label="Ramp progress"
      aria-live="polite"
      aria-busy={busy}
    >
      <h3 className="pollar-ramp-payment-title">{model.title}</h3>
      {snapshot.terms && (
        <p className="pollar-ramp-terms">
          {snapshot.terms.fiatAmount} {snapshot.terms.fiatCurrency} · {snapshot.terms.cryptoAmount} {snapshot.terms.assetCode}
          <br />
          Includes {snapshot.terms.feeAmount} {snapshot.terms.feeCurrency} fee
        </p>
      )}
      {model.details.map((item, index) => (
        <p className="pollar-ramp-workflow-detail" key={index}>
          <strong>{item.label}: </strong>
          {item.value}
        </p>
      ))}
      {model.links.map((link, index) => (
        <p key={index}>
          <a className="pollar-btn-primary pollar-ramp-hosted-link" href={link.url} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        </p>
      ))}
      {model.qr && <QRCode value={model.qr} size={180} />}
      {model.qr && (
        <button
          className="pollar-btn-secondary"
          type="button"
          onClick={() =>
            void navigator.clipboard
              .writeText(model.qr!)
              .catch(() => setError('Unable to copy. Select the payment code to copy it manually.'))
          }
        >
          Copy payment code
        </button>
      )}
      {model.action?.kind === 'collect_information' &&
        model.action.fields.map((field) => (
          <label className="pollar-ramp-field" key={field.key}>
            <span className="pollar-ramp-label">
              {field.label}
              {field.optional ? ' (optional)' : ''}
            </span>
            {field.type === 'select' ? (
              <select
                className="pollar-ramp-input"
                disabled={busy}
                value={fields[field.key] ?? ''}
                onChange={(e) => setFields((previous) => ({ ...previous, [field.key]: e.target.value }))}
              >
                <option value="">Choose</option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="pollar-ramp-input"
                disabled={busy}
                type={field.type}
                placeholder={field.placeholder}
                value={fields[field.key] ?? ''}
                onChange={(e) => setFields((previous) => ({ ...previous, [field.key]: e.target.value }))}
              />
            )}
            {field.hint && <small className="pollar-ramp-field-hint">{field.hint}</small>}
          </label>
        ))}
      {(model.canContinue || model.canSign) && (
        <button
          className="pollar-btn-primary"
          type="button"
          disabled={busy || !fieldsComplete}
          onClick={() => void continueAction()}
        >
          {busy ? (model.canSign ? 'Waiting for your wallet…' : 'Continuing…') : model.canSign ? 'Authorize' : 'Continue'}
        </button>
      )}
      {snapshot.milestones?.map((milestone, index) => (
        <p key={index}>
          {milestone.kind.replace(/_/g, ' ')} · {milestone.verifiedAt}
        </p>
      ))}
      {error && (
        <p className="pollar-ramp-field-error" role="alert">
          {error}
        </p>
      )}
      <small className="pollar-ramp-reference">Reference: {snapshot.txId}</small>
    </section>
  );
}
