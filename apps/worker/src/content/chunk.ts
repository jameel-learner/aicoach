/**
 * Splits parsed pages (Markdown per page) into retrieval chunks (architecture §3.4).
 *  - A chunk never crosses a page, so every citation is an exact page.
 *  - Tables and other blocks are never split (a ledger or balance sheet stays whole).
 *  - Each chunk remembers the nearest heading above it ("section"), carried across pages.
 *  - Running headers/footers (the same first/last line on many pages) are dropped.
 */

export interface ParsedPage {
  pageNo: number;
  markdown: string;
}
export interface Chunk {
  chunkNo: number;
  pageFrom: number;
  pageTo: number;
  section: string | null;
  text: string;
}

const TARGET = 1600; // characters (~400 tokens): small enough to be precise, big enough for context
const MIN_BEFORE_HEADING = 400; // start a new chunk at a heading once the current one has substance
const HARD_MAX = 3500; // split oversized non-table blocks by lines beyond this

const norm = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

/** Lines that start or end at least 20% of pages (min 3) are running headers/footers. */
export function runningLines(pages: ParsedPage[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const lines = p.markdown
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of new Set([lines[0], lines.at(-1)].filter(Boolean) as string[])) {
      const k = norm(l);
      if (k.length > 2 && k.length < 120) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.2));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
}

/** Blocks separated by blank lines; consecutive table lines (|...|) form one block. */
function blocks(markdown: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inTable = false;
  const flush = () => {
    if (cur.length) out.push(cur.join('\n').trim());
    cur = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const isTable = line.trimStart().startsWith('|');
    if (isTable !== inTable && cur.length) flush();
    inTable = isTable;
    if (!line.trim()) {
      if (!inTable) flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return out.filter(Boolean);
}

const headingText = (block: string) => {
  const m = /^#{1,6}\s+(.+)$/.exec(block.split('\n')[0]!);
  return m ? m[1]!.trim() : null;
};

export function chunkPages(pages: ParsedPage[]): Chunk[] {
  const running = runningLines(pages);
  const chunks: Chunk[] = [];
  let section: string | null = null;

  for (const page of [...pages].sort((a, b) => a.pageNo - b.pageNo)) {
    const lines = page.markdown
      .split('\n')
      .filter((l) => !running.has(norm(l)) && !/^\s*\d{1,4}\s*$/.test(l)); // drop bare page numbers
    let buf: string[] = [];
    let bufSection = section;
    const flush = () => {
      const text = buf.join('\n\n').trim();
      if (text.length >= 20) {
        chunks.push({
          chunkNo: chunks.length + 1,
          pageFrom: page.pageNo,
          pageTo: page.pageNo,
          section: bufSection,
          text,
        });
      }
      buf = [];
      bufSection = section;
    };
    const size = () => buf.reduce((n, b) => n + b.length + 2, 0);

    for (const block of blocks(lines.join('\n'))) {
      const h = headingText(block);
      if (h) {
        if (size() >= MIN_BEFORE_HEADING) flush();
        section = h;
        if (!buf.length) bufSection = h;
      }
      const isTable = block.trimStart().startsWith('|');
      if (!isTable && block.length > HARD_MAX) {
        // Rare: a huge paragraph. Split by lines into TARGET-sized pieces.
        flush();
        let piece: string[] = [];
        for (const l of block.split('\n')) {
          if (piece.join('\n').length + l.length > TARGET && piece.length) {
            buf = [piece.join('\n')];
            flush();
            piece = [];
          }
          piece.push(l);
        }
        buf = piece.length ? [piece.join('\n')] : [];
        continue;
      }
      if (size() + block.length > TARGET && buf.length) flush();
      buf.push(block);
    }
    flush();
  }
  return chunks;
}

/** Automatic quality flags shown on the Admin review screen. */
export function pageFlags(markdown: string | null): string[] {
  const text = (markdown ?? '').trim();
  const flags: string[] = [];
  if (text.length < 30) flags.push('empty');
  else if (text.length < 200) flags.push('short');
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (text.length >= 30 && (letters / text.length < 0.45 || text.includes('�')))
    flags.push('garbled');
  return flags;
}
