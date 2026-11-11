import { describe, expect, it } from 'vitest';
import { parsePageList } from './credit-schemas';

describe('parsePageList (pages removed before a PDF is stored)', () => {
  it('parses pages and ranges, sorted and unique', () => {
    expect(parsePageList('1', 10)).toEqual([1]);
    expect(parsePageList(' 3-4, 1 ,4', 10)).toEqual([1, 3, 4]);
  });
  it('rejects bad input', () => {
    expect(parsePageList('0', 10)).toMatch(/between 1 and 10/);
    expect(parsePageList('11', 10)).toMatch(/between 1 and 10/);
    expect(parsePageList('5-3', 10)).toMatch(/between/);
    expect(parsePageList('a', 10)).toMatch(/not a page/);
    expect(parsePageList('1-2', 2)).toMatch(/At least one page/);
  });
});
