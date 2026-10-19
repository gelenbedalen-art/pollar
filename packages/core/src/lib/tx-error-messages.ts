/**
 * User-facing text for a failed transaction or co-sign approval. The backend
 * answers with codes only; this is where the SDK turns the ones a sender can
 * hit into a sentence. A code without an entry falls back to `details` when it
 * reads as a sentence, and to a generic message otherwise, so a raw code never
 * reaches the screen.
 */
const MESSAGES: Record<string, string> = {
  TX_INSUFFICIENT_BALANCE: 'Not enough balance to cover the amount and the network fee.',
  TX_INSUFFICIENT_FEE: 'The network fee was too low for the network right now. Please try again.',
  TX_FEE_LIMIT_EXCEEDED: 'The network fee is higher than this app allows right now. Please try again later.',
  TX_LOW_RESERVE: 'This wallet would fall below its minimum balance.',
  TX_DESTINATION_NOT_FOUND: "The destination account doesn't exist yet.",
  TX_SOURCE_NOT_FOUND: "This wallet isn't active on the network yet.",
  TX_NO_TRUSTLINE: "The destination can't receive this asset yet.",
  TX_LINE_FULL: "The destination can't hold that much of this asset.",
  TX_NOT_AUTHORIZED: "This account isn't authorized to hold or send this asset.",
  TX_TOO_LATE: 'The transaction expired before it was sent. Please try again.',
  TX_BAD_SEQUENCE: 'Another transaction was sent from this wallet at the same time. Please try again.',
  TX_SUBMIT_FAILED: "The network didn't accept the transaction. Please try again.",
  TX_SUBMIT_UNCONFIRMED: "The transaction was sent but isn't confirmed yet. Check its status before sending again.",
  TX_SIGN_FAILED: "The transaction couldn't be signed. Please try again.",
  SDK_TX_BUILD_ERROR: "The transaction couldn't be prepared. Please try again.",
  VALIDATION_ERROR: "The transaction couldn't be prepared. Please try again.",
  SDK_COSIGN_VERIFICATION_FAILED: "The transaction didn't match what would be signed, so it was not approved.",
  SDK_COSIGN_REQUEST_NOT_PENDING: 'This request is no longer waiting for approval.',
  SDK_COSIGN_REQUEST_NOT_FOUND: 'This request no longer exists.',
  SDK_COSIGN_DEVICE_NOT_ENROLLED: "This device can't approve requests for this wallet.",
  SDK_COSIGN_UPSTREAM_ERROR: "The signing service didn't answer. Please try again.",
};

const GENERIC = 'Something went wrong. Please try again.';

/** An error code rather than a sentence: what the backend sends when it has nothing more to say. */
const CODE_LIKE = /^[A-Z0-9_]+$/;

export function transactionErrorMessage(code?: string | null, details?: string | null): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (details && MESSAGES[details]) return MESSAGES[details];
  if (details && !CODE_LIKE.test(details.trim())) return details;
  return GENERIC;
}
