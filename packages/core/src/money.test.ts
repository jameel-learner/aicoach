import { describe, expect, it } from 'vitest';
import {
  formatInr,
  formatRupees,
  MICRO_PER_RUPEE,
  microToUsdNano,
  parseRateToPaise,
  parseRupeesToMicro,
  tokensCostNano,
  usdNanoToBilledMicro,
  usdPerTokenToPico,
  usdToNano,
} from './money';
import { missingCapabilities, modelCapabilities } from './llm';

describe('money (INR wallets, USD provider cost)', () => {
  it('parses rupee amounts exactly', () => {
    expect(parseRupeesToMicro('100')).toBe(100 * MICRO_PER_RUPEE);
    expect(parseRupeesToMicro('8,350.50')).toBe(8_350_500_000);
    expect(parseRupeesToMicro('0.000001')).toBe(1);
    expect(parseRupeesToMicro('0.1')).toBe(100_000); // no float drift
    expect(() => parseRupeesToMicro('-1')).toThrow();
    expect(() => parseRupeesToMicro('1.0000001')).toThrow();
    expect(() => parseRupeesToMicro('abc')).toThrow();
  });

  it('converts USD cost to a rupee charge: × rate × (1 + fee)', () => {
    // $10 at ₹88 = ₹880, +10% = ₹968
    expect(usdNanoToBilledMicro(10e9, 8800, 1000)).toBe(968 * MICRO_PER_RUPEE);
    // a one-word answer: $0.0000049 → ₹0.00047432
    expect(usdNanoToBilledMicro(4_900, 8800, 1000)).toBe(474);
    expect(usdNanoToBilledMicro(4_900, 8800, 0)).toBe(431); // 431.2
    expect(usdNanoToBilledMicro(0, 8800, 1000)).toBe(0);
    // big numbers don't lose precision ($5,000 call total)
    expect(usdNanoToBilledMicro(5_000e9, 8850, 1000)).toBe(486_750 * MICRO_PER_RUPEE);
    expect(microToUsdNano(880 * MICRO_PER_RUPEE, 8800)).toBe(10e9);
    expect(parseRateToPaise('88.5')).toBe(8850);
    expect(() => parseRateToPaise('8')).toThrow();
  });

  it('converts OpenRouter USD costs and prices', () => {
    expect(usdToNano(4.9e-6)).toBe(4_900);
    expect(usdToNano(0.0000121)).toBe(12_100);
    expect(usdToNano(-1)).toBe(0);
    expect(usdPerTokenToPico('0.0000003')).toBe(300_000);
    expect(usdPerTokenToPico('0.0000025')).toBe(2_500_000);
    // 1000 output tokens of gemini-2.5-flash = $0.0025 = 2_500_000 nano
    expect(tokensCostNano(1000, 2_500_000)).toBe(2_500_000);
  });

  it('formats rupees for display', () => {
    expect(formatInr(100 * MICRO_PER_RUPEE)).toBe('₹100.00');
    expect(formatInr(123_456 * MICRO_PER_RUPEE)).toBe('₹1,23,456.00');
    expect(formatInr(474)).toBe('₹0.0005'); // tiny calls never show as ₹0.00
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(-1_500_000)).toBe('-₹1.50');
    expect(formatRupees(98_765_432, 4)).toBe('98.7654');
  });
});

describe('model capabilities', () => {
  it('matches tasks to models', () => {
    const flash = modelCapabilities(['file', 'image', 'text', 'audio', 'video'], true);
    const mini = modelCapabilities(['text', 'image', 'file'], true);
    expect(missingCapabilities('speech_to_text', flash)).toEqual([]);
    expect(missingCapabilities('speech_to_text', mini)).toEqual(['audio']);
    expect(missingCapabilities('grading', modelCapabilities(['text'], false))).toEqual([
      'image',
      'json',
    ]);
  });
});
