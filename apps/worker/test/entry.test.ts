import { describe, expect, it } from 'vitest';
import * as entry from '../src/index';

describe('worker entry module', () => {
  it('exports only handlers/functions (workerd rejects other named exports at startup)', () => {
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'default') continue;
      expect(typeof value, `export "${name}"`).toBe('function');
    }
    expect(typeof entry.default.fetch).toBe('function');
    expect(typeof entry.default.scheduled).toBe('function');
  });
});
