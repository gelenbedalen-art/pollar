// The backend codes the SDK turns into a message the end user can read.
// Run with `npm test` in packages/core (or `npm run test:unit` at the root).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAuthError } from '../src/client/auth/errorMessages';
import { appUnavailableMessage, onChainErrorCode, transactionErrorMessage } from '../src/lib/tx-error-messages';
import { AUTH_ERROR_CODES } from '../src/types';

test("an app out of Pollar credits (402) tells the user to reach the app's support, as every other flow does", () => {
  const resolved = resolveAuthError('SDK_CREDITS_INSUFFICIENT', 'fallback');
  assert.notEqual(resolved.message, 'fallback');
  assert.equal(resolved.message, transactionErrorMessage('SDK_CREDITS_INSUFFICIENT'));
  assert.match(resolved.message, /app's support/);
  assert.equal(resolved.errorCode, AUTH_ERROR_CODES.AUTH_FAILED);
});

test('an app with an overdue Pollar bill (402) reads the same as one out of credits', () => {
  const resolved = resolveAuthError('SDK_BILLING_OVERDUE', 'fallback');
  assert.equal(resolved.message, resolveAuthError('SDK_CREDITS_INSUFFICIENT', 'fallback').message);
  assert.equal(transactionErrorMessage('SDK_BILLING_OVERDUE'), transactionErrorMessage('SDK_CREDITS_INSUFFICIENT'));
  assert.equal(appUnavailableMessage({ code: 'SDK_BILLING_OVERDUE' }), transactionErrorMessage('SDK_CREDITS_INSUFFICIENT'));
});

test('an unknown code keeps the fallback, bucketed by its domain', () => {
  assert.deepEqual(resolveAuthError('TX_SOMETHING_NEW', 'fallback'), {
    message: 'fallback',
    errorCode: AUTH_ERROR_CODES.TX_FAILED,
  });
});

test('a payment to an account that does not exist says so, from the operation code behind txFailed', () => {
  assert.equal(onChainErrorCode('txFailed', 'paymentNoDestination'), 'TX_DESTINATION_NOT_FOUND');
  assert.equal(onChainErrorCode('op_no_destination,tx_failed'), 'TX_DESTINATION_NOT_FOUND');
  const message = transactionErrorMessage('TX_DESTINATION_NOT_FOUND');
  assert.match(message, /doesn't exist/);
  assert.match(message, /created and funded/);
  assert.equal(transactionErrorMessage(null, 'txFailed,paymentNoDestination'), message);
});

test('a bare on-chain code never reaches the screen', () => {
  assert.equal(onChainErrorCode('txFailed'), undefined);
  assert.equal(transactionErrorMessage(null, 'txFailed'), 'Something went wrong. Please try again.');
  assert.equal(transactionErrorMessage(null, 'The memo is too long.'), 'The memo is too long.');
});
