// The backend codes the SDK turns into a message the end user can read.
// Run with `npm test` in packages/core (or `npm run test:unit` at the root).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAuthError } from '../src/client/auth/errorMessages';
import { AUTH_ERROR_CODES } from '../src/types';

test("an app out of Pollar credits (402) tells the user to reach the app's developer, not to retry the payment", () => {
  const resolved = resolveAuthError('SDK_CREDITS_INSUFFICIENT', 'fallback');
  assert.notEqual(resolved.message, 'fallback');
  assert.match(resolved.message, /developer/);
  assert.equal(resolved.errorCode, AUTH_ERROR_CODES.AUTH_FAILED);
});

test('an unknown code keeps the fallback, bucketed by its domain', () => {
  assert.deepEqual(resolveAuthError('TX_SOMETHING_NEW', 'fallback'), {
    message: 'fallback',
    errorCode: AUTH_ERROR_CODES.TX_FAILED,
  });
});
