/**
 * Money (architecture §6.6, decision 9.3-2).
 *
 * - Wallet money is integer **micro-INR**: 1 credit = ₹1 = 1_000_000 µ₹. A one-word answer
 *   (~₹0.0004) is 400 µ₹, so rounding is < 0.2% even on the smallest calls. Safe-integer range
 *   covers ~₹900 crore per value.
 * - The provider's cost is integer **nano-USD** (OpenRouter costs like $0.0000049 = 4_900 nano).
 * - OpenRouter prices are integer **pico-USD per token**.
 * - The USD→INR rate is integer **paise per US$** (8800 = ₹88.00).
 */
export const MICRO_PER_RUPEE = 1_000_000;
export const NANO_PER_USD = 1_000_000_000;
export const DEFAULT_FEE_BPS = 1000; // 10% platform usage fee (decision 6.4), Admin-only
export const DEFAULT_USD_INR_PAISE = 8800; // ₹88.00 per US$, Admin-editable

/** Parse a rupee amount ("100", "12.5", "0.0001") into micro-INR without float error. */
export function parseRupeesToMicro(input: string | number): number {
  const s = String(input).trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error('Enter an amount like 100 or 12.50');
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(6, '0'));
  return whole * MICRO_PER_RUPEE + frac;
}

/** Format micro-INR as a rupee number string, e.g. "1,23,456.78". Trailing zeros trimmed to `minDigits`. */
export function formatRupees(micro: number, maxDigits = 2, minDigits = 2): string {
  const neg = micro < 0;
  const abs = Math.abs(micro);
  const scale = 10 ** (6 - maxDigits);
  const rounded = Math.round(abs / scale); // in units of 10^-maxDigits rupees
  const whole = Math.floor(rounded / 10 ** maxDigits);
  let frac = maxDigits > 0 ? String(rounded % 10 ** maxDigits).padStart(maxDigits, '0') : '';
  while (frac.length > minDigits && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${neg ? '-' : ''}${whole.toLocaleString('en-IN')}${frac ? '.' + frac : ''}`;
}

/** "₹1,234.50"; tiny non-zero amounts get up to 4 decimals so a call never shows as ₹0.00. */
export function formatInr(micro: number): string {
  const abs = Math.abs(micro);
  const digits = abs !== 0 && abs < 10_000 ? 4 : 2; // below ₹0.01
  const s = formatRupees(micro, digits, 2);
  return s.startsWith('-') ? `-₹${s.slice(1)}` : `₹${s}`;
}

/** OpenRouter reports cost as a USD float; convert to nano-USD (exact for its precision). */
export function usdToNano(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * NANO_PER_USD);
}

/**
 * Provider cost (nano-USD) → wallet charge (micro-INR): × rate × (1 + fee), rounded half-up.
 * BigInt because nano × paise × bps overflows 2^53 for larger calls.
 */
export function usdNanoToBilledMicro(rawNanoUsd: number, usdInrPaise: number, feeBps: number) {
  if (rawNanoUsd <= 0) return 0;
  // micro-INR = nano-USD / 1e9 × (paise / 100) × 1e6 × (10000 + bps) / 10000
  //           = nano × paise × (10000 + bps) / 1e9
  const num = BigInt(rawNanoUsd) * BigInt(usdInrPaise) * BigInt(10_000 + feeBps);
  const den = 1_000_000_000n;
  return Number((num + den / 2n) / den);
}

/** Wallet micro-INR → nano-USD at a rate, before any fee (for the float panel). */
export function microToUsdNano(micro: number, usdInrPaise: number): number {
  // nano-USD = micro / 1e6 / (paise / 100) × 1e9 = micro × 1e5 / paise
  return Math.round((micro * 100_000) / usdInrPaise);
}

/** OpenRouter per-token USD price string ("0.0000003") → integer pico-USD per token. */
export function usdPerTokenToPico(price: string | number | undefined | null): number {
  const n = Number(price ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e12);
}

/** Cost in nano-USD for tokens at a pico-per-token price (rounded up: estimates must not undershoot). */
export function tokensCostNano(tokens: number, picoPerToken: number): number {
  return Math.ceil((tokens * picoPerToken) / 1000);
}

/** "88.50" → 8850 paise per US$. */
export function parseRateToPaise(input: string): number {
  const m = /^(\d{2,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error('Enter a rate like 88.50');
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
