/**
 * Calculator check for "show working" (decision 9.6-6). Finds the sums written in a tutor reply or
 * a worked answer ("12,000 × 3/5 = 7,200") and recomputes them. A sum that doesn't work out is
 * reported so the app can flag it. Anything that isn't plainly arithmetic is left alone: a missed
 * sum is better than a false alarm.
 */

export interface WrongSum {
  /** The sum as written, e.g. "12,000 × 3/5 = 7,000". */
  expression: string;
  stated: number;
  actual: number;
}

const tidy = (s: string) =>
  s
    .replace(/\*\*|__|`|\$/g, '')
    .replace(/₹|\bRs\.?(?=\s|\d)|\bINR\b/gi, '')
    .replace(/[−–—]/g, '-')
    .replace(/[×✕]/g, '*')
    .replace(/÷/g, '/')
    .replace(/(?<=[\d)%])\s*[xX]\s*(?=[\d(])/g, '*')
    .replace(/%\s*of\s+/gi, '%*')
    .trim();

/** Recursive-descent evaluator for + - * / ( ) and numbers with Indian/Western digit grouping and %. */
function evaluate(src: string): number | null {
  let i = 0;
  const s = src.replace(/\s+/g, '');
  if (!s) return null;
  const number = (): number | null => {
    const m = /^\d[\d,]*(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) return null;
    // A comma must be followed by 2 or 3 digits ("1,20,000"); "3,5" is a list, not a number.
    if (/,(?!\d{2,3}(?!\d))/.test(m[0])) return null;
    i += m[0].length;
    let v = Number(m[0].replace(/,/g, ''));
    if (s[i] === '%') {
      i++;
      v /= 100;
    }
    return v;
  };
  const factor = (): number | null => {
    if (s[i] === '-') {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (s[i] === '(') {
      i++;
      const v = sum();
      if (v === null || s[i] !== ')') return null;
      i++;
      if (s[i] === '%') {
        i++;
        return v / 100;
      }
      return v;
    }
    return number();
  };
  const product = (): number | null => {
    let v = factor();
    while (v !== null && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++];
      const r = factor();
      if (r === null) return null;
      if (op === '/' && r === 0) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  function sum(): number | null {
    let v = product();
    while (v !== null && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++];
      const r = product();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}

const hasOperator = (s: string) => /[+*/]|\d\s*-\s*[\d(]|\d%\*/.test(s);
/** Rounded figures are fine: within half a percent, or within 1 for amounts written without paise. */
const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.005 * Math.abs(b), Math.abs(b) >= 100 ? 1 : 0.011);

/** Leading words ("Interest on capital = …") are dropped; the sum is what follows. */
const lastClause = (s: string) => {
  const m = /[\d(.-][\d\s.,()%*/+-]*$/.exec(s);
  return m ? m[0].trim() : s;
};

export function checkArithmetic(text: string): { checked: number; wrong: WrongSum[] } {
  const wrong: WrongSum[] = [];
  let checked = 0;
  for (const raw of text.split('\n')) {
    // A ratio ("3:2") is not a division, and a table row is a statement, not a sum.
    for (const cell of raw.split('|')) {
      const line = tidy(cell);
      if (!line.includes('=')) continue;
      const parts = line.split('=').map((p) => p.trim());
      for (let k = 0; k + 1 < parts.length; k++) {
        const leftRaw = k === 0 ? lastClause(parts[k]!) : parts[k]!;
        // The right side may be followed by words or a bracket: "= 7,200 each.", "= 12,000)".
        const tail = parts[k + 1]!;
        const full = /^-?[\d(.][\d\s.,()%*/+-]*/.exec(tail)?.[0]?.replace(/[.,\s(]+$/, '');
        const plain = /^-?\d[\d,]*(\.\d+)?%?(\s*\/\s*\d[\d,]*)?/.exec(tail)?.[0];
        if (!full || !hasOperator(leftRaw) || /:/.test(leftRaw + full)) continue;
        // "(2,00,000 × 6/100 = 12,000)": the sum sits inside a bracket.
        const left = evaluate(leftRaw) === null ? leftRaw.replace(/^\(+/, '') : leftRaw;
        const a = evaluate(left);
        const right = evaluate(full) === null && plain ? plain : full;
        const b = evaluate(right);
        if (a === null || b === null) continue;
        checked++;
        // "10,000 ÷ 50,000 × 100 = 20%": the left side already is the percentage.
        const asPercent = /%$/.test(right) && close(a, b * 100);
        if (!close(a, b) && !asPercent)
          wrong.push({
            expression: `${left} = ${right}`.replace(/\*/g, '×').replace(/\//g, '÷'),
            stated: b,
            actual: Math.round(a * 100) / 100,
          });
      }
    }
  }
  return { checked, wrong };
}

/** One line per wrong sum, for the learner. */
export const describeWrongSums = (w: WrongSum[]) =>
  w.map(
    (x) =>
      `${x.expression} doesn't work out: it comes to ${x.actual.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
  );
