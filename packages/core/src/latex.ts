/**
 * LaTeX formulas → readable plain text, for places that can't render KaTeX (the phone app, citation
 * snippets). The OCR writes textbook formulas as `$…$` / `$$…$$`, e.g.
 * `$\frac{\text{Rs. 2,00,000} \times 8 \times 3}{100 \times 12}$` → `(Rs. 2,00,000 × 8 × 3) / (100 × 12)`.
 * Only the commands that appear in the textbooks are handled; unknown commands lose the backslash.
 */

const SYMBOLS: Record<string, string> = {
  times: '×',
  div: '÷',
  cdot: '·',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  rightarrow: '→',
  to: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  infty: '∞',
  ldots: '…',
  dots: '…',
  cdots: '…',
  percent: '%',
  rupee: '₹',
  alpha: 'α',
  beta: 'β',
  Delta: 'Δ',
  sum: 'Σ',
};
/** Commands whose braced argument is shown as it is. */
const TEXT = new Set([
  'text',
  'mathrm',
  'textrm',
  'textbf',
  'mathbf',
  'textit',
  'mathit',
  'operatorname',
  'mbox',
  'boxed',
  'underline',
  'overline',
]);
const SPACES = new Set(['quad', 'qquad', ',', ';', ':', ' ', '!']);
/** Dropped with their argument count. */
const DROP: Record<string, number> = { left: 0, right: 0, displaystyle: 0, hline: 0, end: 1 };

/** Reads `{…}` (balanced) or a single token starting at i; returns [content, next index]. */
function group(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '\\') {
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
    return [m![0], i + m![0].length];
  }
  return [s[i] ?? '', i + 1];
}

/** "8" or "Rs. 2,000" stay bare in a fraction; anything with an operator gets brackets. */
const simple = (t: string) =>
  /^[\w.,%₹]+$/.test(t.trim()) || /^(Rs\.?|₹)\s*[\d,.]+$/.test(t.trim());
const wrap = (t: string) => (simple(t) ? t.trim() : `(${t.trim()})`);

function convert(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\') {
      if (s[i + 1] === '\\') {
        out += '\n';
        i += 2;
        continue;
      }
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      const name = m ? m[1]! : '';
      i += m ? m[0].length : 1;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, j] = group(s, i);
        const [b, k] = group(s, j);
        i = k;
        const num = convert(a);
        const den = convert(b);
        // A mixed number like 6\frac{1}{2} reads "6 1/2".
        if (/\d$/.test(out)) out += ' ';
        out +=
          simple(num) && simple(den)
            ? `${num.trim()}/${den.trim()}`
            : `${wrap(num)} / ${wrap(den)}`;
        continue;
      }
      if (name === 'sqrt') {
        const [a, j] = group(s, i);
        i = j;
        out += `√${wrap(convert(a))}`;
        continue;
      }
      if (name === 'begin') {
        // \begin{array}{l} → drop the environment name and its column spec
        const [env, j] = group(s, i);
        i = j;
        if (/array|tabular/.test(env) && s[i] === '{') i = group(s, i)[1];
        continue;
      }
      if (TEXT.has(name)) {
        const [a, j] = group(s, i);
        i = j;
        out += convert(a);
        continue;
      }
      if (name in DROP) {
        for (let n = 0; n < DROP[name]!; n++) i = group(s, i)[1];
        continue;
      }
      if (SPACES.has(name)) {
        out += ' ';
        continue;
      }
      if (name in SYMBOLS) {
        out += SYMBOLS[name];
        continue;
      }
      if (/^[%&$#_{}]$/.test(name)) {
        out += name;
        continue;
      }
      out += name; // unknown command: keep its name without the backslash
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch === '&') {
      out += ' ';
      i++;
      continue;
    }
    if (ch === '^' || ch === '_') {
      const [a, j] = group(s, i + 1);
      i = j;
      const v = convert(a);
      out += ch === '^' ? (v.length === 1 ? `^${v}` : `^(${v})`) : v.length === 1 ? v : `(${v})`;
      continue;
    }
    if (ch === '~') {
      out += ' ';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const tidy = (s: string) =>
  s
    .split('\n')
    .map((l) =>
      l
        .replace(/[ \t]+/g, ' ')
        .replace(/\( /g, '(')
        .replace(/ \)/g, ')')
        .replace(/ ([,.])(?=\s|$)/g, '$1')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');

/** One formula (without the $ signs) as plain text. */
export function latexToText(latex: string): string {
  return tidy(convert(latex));
}

/**
 * Replaces every `$$…$$` (own lines) and `$…$` (inline) formula in Markdown text with plain text.
 * A lone "$" (e.g. "US$5") is left alone: an inline formula needs a closing "$" on the same line
 * and must not start or end with a space.
 */
export function mathToText(markdown: string): string {
  return markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, f: string) => `\n${latexToText(f)}\n`)
    .replace(/\$(?=\S)([^$\n]*?\S)\$/g, (_, f: string) => latexToText(f))
    .replace(/\n{3,}/g, '\n\n');
}
