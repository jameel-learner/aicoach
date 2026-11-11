import { marksTarget, type AssetCheck, type NoteDraft } from '@aicoach/core';

/**
 * Model-independent checks on generated notes (decision 9.5-4): they catch arithmetic and format
 * slips whichever model wrote the note. Cheap, deterministic, shown to the reviewer.
 */

/** "1,27,300" (Indian grouping), "₹ 8,000", "(30,000)" → numbers; null if the cell isn't a number. */
export function cellNumber(cell: string): number | null {
  const t = cell.replace(/[₹*\s]/g, '').replace(/^Rs\.?/i, '');
  const m = /^\(?(-?[\d,]+(?:\.\d+)?)\)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return t.startsWith('(') ? -n : n;
}

/** Markdown tables in a text: rows of cells (separator rows dropped). */
export function markdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  let cur: string[][] = [];
  for (const line of md.split('\n')) {
    const l = line.trim();
    if (l.startsWith('|') && l.endsWith('|') && l.length > 1) {
      const cells = l
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) cur.push(cells);
    } else if (cur.length) {
      tables.push(cur);
      cur = [];
    }
  }
  if (cur.length) tables.push(cur);
  return tables;
}

/**
 * Two-sided accounts (Dr | Cr) must tally: on a row with two "Total" cells, the amounts after the
 * first must equal the amounts after the second (several partners' columns too). A vertical
 * balance sheet's "Total equity and liabilities" must equal its "Total assets".
 */
export function tallyProblems(md: string): string[] {
  const problems: string[] = [];
  for (const table of markdownTables(md)) {
    for (const row of table) {
      const totals = row.map((c, i) => (/\btotal\b/i.test(c) ? i : -1)).filter((i) => i >= 0);
      if (totals.length !== 2) continue;
      const nums = (from: number, to: number) =>
        row
          .slice(from + 1, to)
          .map(cellNumber)
          .filter((n): n is number => n !== null);
      const left = nums(totals[0]!, totals[1]!);
      const right = nums(totals[1]!, row.length);
      if (left.length && right.length && left.join() !== right.join())
        problems.push(`Totals don't tally: ${left.join(', ')} vs ${right.join(', ')}`);
    }
    const lastNums = (re: RegExp) => {
      const r = table.find((row) => re.test(row[0] ?? ''));
      return r
        ? r
            .slice(1)
            .map(cellNumber)
            .filter((n): n is number => n !== null)
        : null;
    };
    const liab = lastNums(/total.*(equity|liabilit)/i);
    const assets = lastNums(/total.*asset/i);
    if (liab?.length && assets?.length && liab.join() !== assets.join())
      problems.push(`Balance sheet doesn't balance: ${liab.join(', ')} vs ${assets.join(', ')}`);
  }
  return problems;
}

/** "1+2+2+1=6" → 6, "each item 1 mark: 6x1=6" → 6, "3 × 4" → 12; null if it can't be read. */
export function splitTotal(split: string): number | null {
  const s = split.replace(/\s+/g, '').toLowerCase();
  const eq = /=(\d+)$/.exec(s);
  const lhs = s.replace(/=\d+$/, '').replace(/^.*?:/, '');
  const product = /^(\d+)[x×*](\d+)$/.exec(lhs);
  if (product) return Number(product[1]) * Number(product[2]);
  if (/^\d+(\+\d+)+$/.test(lhs)) return lhs.split('+').reduce((a, b) => a + Number(b), 0);
  return eq ? Number(eq[1]) : null;
}

/** Words, numbers and table cells (what a student would have to write). */
export const words = (t: string) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu) ?? []).length;

/**
 * @param budget the exam answer's time and length budget (examBudget in @aicoach/core).
 */
export function noteChecks(
  note: NoteDraft,
  marks: number,
  sourceCount: number,
  budget: { minutes: number; maxWords: number },
): AssetCheck[] {
  const target = marksTarget(marks);
  const study = [note.summary, ...note.sections.map((s) => `${s.heading}\n${s.body}`)].join('\n');
  const exam = note.examAnswer;
  const all = [study, `${exam.question}\n${exam.answer}`].join('\n');
  const checks: AssetCheck[] = [];

  const cited = [...all.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1]));
  const unknown = [...new Set(cited.filter((n) => n < 1 || n > sourceCount))];
  checks.push({
    name: 'Cites the textbook',
    ok: cited.length > 0 && unknown.length === 0,
    detail: unknown.length
      ? `cites excerpts that don't exist: ${unknown.map((n) => `S${n}`).join(', ')}`
      : `${new Set(cited).size} of ${sourceCount} excerpts cited`,
  });

  // The exam answer is what the student writes: it must fit the time the paper allows.
  const e = words(exam.answer);
  checks.push({
    name: `Exam answer fits ${budget.minutes} min`,
    ok: e > 0 && e <= budget.maxWords * 1.15,
    detail: e
      ? `${e} words (about ${budget.maxWords} can be written in ${budget.minutes} min)`
      : 'missing',
  });
  // The study part is read, not memorised: only a loose upper limit.
  const s = words(study);
  checks.push({
    name: 'Study part not too long',
    ok: s <= target.maxWords * 1.25,
    detail: `${s} words (guide ${target.minWords}–${target.maxWords})`,
  });

  if (target.workedExample) {
    const tally = tallyProblems(exam.answer);
    checks.push({
      name: 'Accounts and statements tally',
      ok: tally.length === 0,
      detail: tally.length ? tally.slice(0, 3).join('; ') : 'all totals agree',
    });
  }
  const total = exam.marksSplit ? splitTotal(exam.marksSplit) : null;
  if (marks > 1 || total !== null)
    checks.push({
      name: 'Marks allotment adds up',
      ok: total === null ? marks <= 2 : total === marks,
      detail:
        total === null
          ? exam.marksSplit
            ? `couldn't read "${exam.marksSplit}"`
            : 'no allotment given'
          : `${exam.marksSplit} = ${total} (question: ${marks})`,
    });
  return checks;
}
