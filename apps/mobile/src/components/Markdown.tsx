import { mathToText } from '@aicoach/core';
import { Fragment, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTheme } from '../lib/theme';

/**
 * Small Markdown renderer for tutor answers: headings, paragraphs, bullet/numbered lists, tables
 * (horizontally scrollable), **bold**, and [S#] citation markers rendered as tappable page badges.
 * Deliberately limited to what the tutor prompt produces. LaTeX formulas ($…$, copied from the
 * textbook) are shown as plain text (decision 9.5-9).
 */
export function Markdown({
  text,
  renderCitation,
}: {
  text: string;
  renderCitation?: (n: number) => ReactNode;
}) {
  const { colors, fontSize, space } = useTheme();
  const base = { color: colors.text, fontSize: fontSize.md, lineHeight: 24 };

  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|\[S\d+\])/g).map((part, i) => {
      const cite = /^\[S(\d+)\]$/.exec(part);
      if (cite)
        return <Fragment key={`${key}-${i}`}>{renderCitation?.(Number(cite[1])) ?? null}</Fragment>;
      if (part.startsWith('**') && part.endsWith('**'))
        return (
          <Text key={`${key}-${i}`} style={{ fontWeight: '700' }}>
            {part.slice(2, -2)}
          </Text>
        );
      return part;
    });

  const blocks: ReactNode[] = [];
  const lines = mathToText(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const key = `b${i}`;
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) {
        const cells = lines[i]!.trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      blocks.push(
        <ScrollView key={key} horizontal style={{ marginVertical: space[2] }}>
          <View style={{ borderWidth: 1, borderColor: colors.border }}>
            {rows.map((r, ri) => (
              <View
                key={ri}
                style={{
                  flexDirection: 'row',
                  backgroundColor: ri === 0 ? colors.surfaceMuted : undefined,
                }}
              >
                {r.map((c, ci) => (
                  <Text
                    key={ci}
                    style={{
                      ...base,
                      fontSize: fontSize.sm,
                      minWidth: 90,
                      maxWidth: 220,
                      padding: 6,
                      borderRightWidth: 1,
                      borderTopWidth: ri ? 1 : 0,
                      borderColor: colors.border,
                      fontWeight: ri === 0 ? '700' : '400',
                    }}
                  >
                    {inline(c, `${key}-${ri}-${ci}`)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <Text
          key={key}
          style={{ ...base, fontWeight: '700', fontSize: fontSize.lg, marginTop: space[2] }}
        >
          {inline(h[2]!, key)}
        </Text>,
      );
      continue;
    }
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      blocks.push(
        <View key={key} style={{ flexDirection: 'row', gap: 6, paddingLeft: 4 }}>
          <Text style={base}>{li[1] ? `${li[1]}.` : '•'}</Text>
          <Text style={{ ...base, flex: 1 }}>{inline(li[2]!, key)}</Text>
        </View>,
      );
      continue;
    }
    blocks.push(
      <Text key={key} style={{ ...base, marginVertical: 4 }}>
        {inline(line, key)}
      </Text>,
    );
  }
  return <View>{blocks}</View>;
}
