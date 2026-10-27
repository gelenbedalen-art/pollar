export const EMAIL_CODE_LENGTH = 6;

export interface EmailCodeUpdate {
  digits: string[];
  /** Index of the box that should receive focus next. */
  focus: number;
}

/**
 * Apply what the browser wrote into box `index` to the 6 code boxes.
 *
 * A keystroke leaves one digit in the box, or two when the box already held
 * one (the old digit plus the new one). OTP autofill on iOS and Android, and
 * some keyboards' paste, instead write the whole code into the focused box
 * through an input event, not a paste event. That value is spread across the
 * boxes: a full code always from the first box, a shorter run from `index`.
 */
export function applyEmailCodeInput(digits: string[], index: number, value: string): EmailCodeUpdate {
  const last = EMAIL_CODE_LENGTH - 1;
  const raw = value.replace(/\D/g, '');
  const next = digits.slice();

  const previous = digits[index] ?? '';
  const isKeystroke = raw.length <= 1 || (raw.length === 2 && previous !== '' && raw.includes(previous));
  if (isKeystroke) {
    // Typing over a filled box: keep the digit that was added, wherever the caret was.
    const typed = raw.length === 2 ? (raw.startsWith(previous) ? raw[1] : raw[0]) : raw;
    next[index] = typed ?? '';
    return { digits: next, focus: typed && index < last ? index + 1 : index };
  }

  // A full code may arrive appended to a digit already in the box; keep its last 6 digits.
  const start = raw.length >= EMAIL_CODE_LENGTH ? 0 : index;
  const chars = raw.length >= EMAIL_CODE_LENGTH ? raw.slice(-EMAIL_CODE_LENGTH) : raw.slice(0, EMAIL_CODE_LENGTH - index);
  for (let i = 0; i < chars.length; i++) next[start + i] = chars[i] as string;
  return { digits: next, focus: Math.min(start + chars.length, last) };
}

/** Spread pasted text across the boxes from the first one. */
export function applyEmailCodePaste(text: string): EmailCodeUpdate {
  const code = text.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH);
  const digits = Array.from({ length: EMAIL_CODE_LENGTH }, (_, i) => code[i] ?? '');
  return { digits, focus: Math.min(Math.max(code.length - 1, 0), EMAIL_CODE_LENGTH - 1) };
}
