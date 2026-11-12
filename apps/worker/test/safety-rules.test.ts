import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/safety/rules';
import { REDTEAM } from './fixtures/safety-redteam';

/** Phase 4 exit: 100% of the red-team distress cases route to the handoff, by the rules alone. */
describe('safety rules', () => {
  it('catches every distress message of the red-team set', () => {
    const missed = REDTEAM.distress.filter((t) => checkRules(t).level !== 'distress');
    expect(missed).toEqual([]);
    expect(REDTEAM.distress.length).toBeGreaterThanOrEqual(75);
  });

  it('offers a smaller plan for "too much" wording, without alerting anyone', () => {
    const wrong = REDTEAM.overwhelm.filter((t) => checkRules(t).level !== 'overwhelm');
    expect(wrong).toEqual([]);
  });

  it('lets study messages through, including Accountancy wording about death and dissolution', () => {
    const flagged = REDTEAM.ok
      .map((t) => ({ t, v: checkRules(t) }))
      .filter((x) => x.v.level !== 'ok')
      .map((x) => `${x.t} → ${x.v.level} (${x.v.rule})`);
    expect(flagged).toEqual([]);
  });

  it('names the rule that fired (stored instead of the message)', () => {
    expect(checkRules('my father beats me')).toEqual({ level: 'distress', rule: 'harm_by_others' });
    expect(checkRules('mar jaunga')).toEqual({ level: 'distress', rule: 'self_harm_hi' });
    expect(checkRules('')).toEqual({ level: 'ok', rule: null });
  });
});
