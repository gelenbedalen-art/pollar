import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeRampAction,
  rampFieldValid,
  rampLegStatus,
  rampOrderReceive,
  rampOrderResolutionText,
  rampOrderStopped,
  rampWalletStep,
} from '../src/ramps/workflow';

const usdc = { kind: 'asset' as const, code: 'USDC', identifier: 'GA5Z', chain: 'STELLAR' as const };
const bob = { kind: 'fiat' as const, currency: 'BOB', rail: 'QR', country: 'BO' };

test('a leg retrying on its own is active; only a leg that stopped is failed', () => {
  const failure = { code: 'RPC_UNAVAILABLE', retryable: true, resolutionOwner: 'POLLAR', resolutionAction: 'automatic_retry' };
  assert.equal(rampLegStatus({ status: 'ACTIVE', failure } as never), 'active');
  assert.equal(rampLegStatus({ status: 'HELD', failure } as never), 'failed');
  assert.equal(rampLegStatus({ status: 'FAILED', failure: null } as never), 'failed');
  assert.equal(rampLegStatus({ status: 'COMPLETED', failure: null } as never), 'done');
  assert.equal(rampLegStatus({ status: 'PENDING', failure: null } as never), 'pending');
});

test('what the user receives is the last leg, as received once it is, else as planned', () => {
  const leg = (amountOutActual: string | null) => ({ to: usdc, amountOutPlanned: '14.2', amountOutActual });
  assert.deepEqual(rampOrderReceive({ legs: [leg(null)] } as never), { amount: '14.2', unit: 'USDC' });
  assert.deepEqual(rampOrderReceive({ legs: [leg('14.19')] } as never), { amount: '14.19', unit: 'USDC' });
  assert.deepEqual(rampOrderReceive({ legs: [{ to: bob, amountOutPlanned: '100', amountOutActual: null }] } as never), {
    amount: '100',
    unit: 'BOB',
  });
  assert.equal(rampOrderReceive({ legs: [] } as never), null);
});

test('an order stops moving on its own once final, or held with no next read', () => {
  assert.equal(rampOrderStopped({ state: 'processing', nextPollAfter: '2026-10-23T12:00:00Z' }), false);
  assert.equal(rampOrderStopped({ state: 'processing', nextPollAfter: null }), true);
  assert.equal(rampOrderStopped({ state: 'completed', nextPollAfter: null }), true);
});

test('a field is complete when filled and, for an email, well-formed; an optional one may stay blank', () => {
  assert.equal(rampFieldValid({ type: 'text' }, ' '), false);
  assert.equal(rampFieldValid({ type: 'text', optional: true }, ''), true);
  assert.equal(rampFieldValid({ type: 'email' }, 'ana@pollar.xyz'), true);
  assert.equal(rampFieldValid({ type: 'email', optional: true }, 'not-an-email'), false);
});

test("a payment's window is part of how the action is shown", () => {
  const order = {
    state: 'awaiting_payment',
    pendingAction: {
      kind: 'FIAT_PAYMENT',
      actionId: 'pay',
      legIndex: 0,
      expiresAt: '2026-10-23T12:10:00.000Z',
      instructions: { kind: 'qr', payload: 'QR', amount: '20', currency: 'BOB' },
    },
  };
  assert.equal(describeRampAction(order as never).expiresAt, '2026-10-23T12:10:00.000Z');
  assert.equal(describeRampAction({ state: 'processing', pendingAction: null } as never).expiresAt, null);
});

test('an expired provider order reads differently once the funds moved: the user tries again, nothing is lost', () => {
  const failure = {
    code: 'PROVIDER_ORDER_EXPIRED',
    retryable: false,
    resolutionOwner: 'END_USER',
    resolutionAction: 'start_again',
  };
  const failed = rampOrderResolutionText({ failure, legs: [{ status: 'FAILED' }] } as never);
  const held = rampOrderResolutionText({ failure, legs: [{ status: 'COMPLETED' }, { status: 'HELD' }] } as never);
  assert.match(failed!, /nothing was charged/);
  assert.match(held!, /funds are safe in your wallet: try again/);
  assert.equal(rampOrderResolutionText({ failure: null, legs: [] } as never), null);
  const other = { ...failure, resolutionAction: 'contact_pollar' };
  assert.equal(
    rampOrderResolutionText({ failure: other, legs: [{ status: 'HELD' }] } as never),
    rampOrderResolutionText({ failure: other, legs: [{ status: 'FAILED' }] } as never),
  );
});

test('a dropped route that needs a wallet names the step and, to set one up, its chain', () => {
  const failure = (resolutionAction: string, detail?: string) =>
    ({ failure: { code: 'X', legIndex: 0, retryable: false, resolutionOwner: 'END_USER', resolutionAction, detail } }) as never;
  assert.deepEqual(rampWalletStep(failure('set_up_wallet', 'POLYGON')), {
    action: 'set_up_wallet',
    chain: 'POLYGON',
    label: 'Set up wallet',
    busyLabel: 'Setting up…',
  });
  assert.equal(rampWalletStep(failure('set_up_wallet', 'STELLAR')), null, 'never a Stellar wallet');
  assert.equal(rampWalletStep(failure('set_up_wallet')), null);
  assert.equal(rampWalletStep(failure('migrate_custody'))!.label, 'Move wallet');
  assert.equal(rampWalletStep(failure('create_wallet'))!.label, 'Create wallet');
  assert.equal(rampWalletStep(failure('add_trustline')), null);
});
