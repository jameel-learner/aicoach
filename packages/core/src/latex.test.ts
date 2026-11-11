import { describe, expect, it } from 'vitest';
import { latexToText, mathToText } from './latex';

/** Formulas as the OCR wrote them in the NCERT Accountancy pages. */
describe('LaTeX → plain text (phone, citation snippets)', () => {
  it('reads fractions, × and \\text the way a student would write them', () => {
    expect(
      latexToText(
        String.raw`\text{Interest on Rs. 2,00,000 for 3 months} = \frac{\text{Rs. 2,00,000} \times 8 \times 3}{100 \times 12} = 4,000`,
      ),
    ).toBe('Interest on Rs. 2,00,000 for 3 months = (Rs. 2,00,000 × 8 × 3) / (100 × 12) = 4,000');
    expect(
      latexToText(
        String.raw`\text{Average Period} = \frac{\text{No. of months of 1 drawings} + \text{No. of month of last drawings}}{2} = \frac{12 + 1}{2} = 6\frac{1}{2} \text{ months}.`,
      ),
    ).toBe(
      'Average Period = (No. of months of 1 drawings + No. of month of last drawings) / 2 = (12 + 1) / 2 = 6 1/2 months.',
    );
    expect(
      latexToText(
        String.raw`\text{Current Ratio} = \text{Current Assets} : \text{Current Liabilities or} \frac{\text{Current Assets}}{\text{Current Liabilities}}`,
      ),
    ).toBe(
      'Current Ratio = Current Assets : Current Liabilities or (Current Assets) / (Current Liabilities)',
    );
    expect(latexToText(String.raw`8\%`)).toBe('8%');
    expect(latexToText(String.raw`\frac{\text{Rs. } 6,000}{2}`)).toBe('Rs. 6,000/2');
    expect(latexToText(String.raw`\sqrt{x^2 + y_{1}}`)).toBe('√(x^2 + y1)');
  });

  it('keeps the lines of an array and drops \\left/\\right', () => {
    expect(
      latexToText(String.raw`\begin{array}{l}
\text{For Mansoor } \left( \mathrm{Rs.}\ 2,00,000 \times \frac{6}{100} \right) + \left( \mathrm{Rs.}\ 1,00,000 \times \frac{6}{100} \times \frac{8}{12} \right) \\
= \mathrm{Rs.}\ 12,000 + \mathrm{Rs.}\ 4,000 = \mathrm{Rs.}\ 16,000
\end{array}`),
    ).toBe(
      'For Mansoor (Rs. 2,00,000 × 6/100) + (Rs. 1,00,000 × 6/100 × 8/12)\n= Rs. 12,000 + Rs. 4,000 = Rs. 16,000',
    );
  });

  it('replaces $…$ and $$…$$ in Markdown and leaves a lone $ alone', () => {
    expect(
      mathToText(
        String.raw`Rate $8\%$ p.a. on US$5 for $6\frac{1}{2}$ months.` +
          '\n\n$$\n' +
          String.raw`\text{Interest} = \frac{a}{b}` +
          '\n$$\nNext',
      ),
    ).toBe('Rate 8% p.a. on US$5 for 6 1/2 months.\n\nInterest = a/b\n\nNext');
    expect(mathToText('No formulas here | a | b |')).toBe('No formulas here | a | b |');
  });
});
