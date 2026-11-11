import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * Markdown plugins for textbook text, answers and material: GFM tables plus LaTeX formulas
 * (`$…$`, `$$…$$`, as the OCR writes them) rendered with KaTeX. A formula KaTeX can't parse is
 * shown as its source instead of breaking the page.
 */
export const remarkPlugins = [remarkGfm, remarkMath];
export const rehypePlugins: [typeof rehypeKatex, { throwOnError: boolean; strict: 'ignore' }][] = [
  [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
];
