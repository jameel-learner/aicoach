import { Pressable, Text, View } from 'react-native';
import { errorMessage } from '../lib/api';
import { useEnrolment } from '../lib/enrolment-context';
import { useMaterialIndex } from '../lib/material';
import { useTheme } from '../lib/theme';
import { Body, Card, ErrorText, Heading } from './ui';

/** Small rounded label, e.g. "6 marks". */
export function Pill({ label, strong }: { label: string; strong?: boolean }) {
  const { colors, radius, fontSize } = useTheme();
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        borderRadius: radius.pill,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: strong ? colors.primary : colors.surfaceMuted,
      }}
    >
      <Text
        style={{
          color: strong ? colors.primaryText : colors.text,
          fontSize: fontSize.xs,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function OfflineNote() {
  const { colors, fontSize } = useTheme();
  return (
    <Text style={{ color: colors.warning, fontSize: fontSize.sm }}>
      Offline: showing what you opened before.
    </Text>
  );
}

/**
 * The subject's chapters with their weight in the paper and what is ready to study.
 * `mode="practice"` shows the question sets; `mode="study"` the notes and cards.
 */
export function ChapterList({
  mode,
  onOpen,
}: {
  mode: 'study' | 'practice';
  onOpen: (no: number) => void;
}) {
  const { colors, fontSize, radius } = useTheme();
  const { active } = useEnrolment();
  const index = useMaterialIndex(active?.id);
  if (index.error) return <ErrorText error={errorMessage(index.error)} />;
  if (!index.data) return <Body muted>Loading…</Body>;
  const d = index.data;
  if (!d.ready)
    return (
      <Card>
        <Heading>Study material is on its way</Heading>
        <Body muted>
          Notes, revision cards and practice questions for your subject appear here once your
          teachers have checked them.
        </Body>
      </Card>
    );
  return (
    <View style={{ gap: 12 }}>
      {d.offline && <OfflineNote />}
      {d.chapters.map((c) => {
        const has = mode === 'practice' ? c.questionSets.length > 0 : c.notes > 0 || c.cards;
        const what =
          mode === 'practice'
            ? c.questionSets.length
              ? `Questions at ${c.questionSets.join(', ')} marks`
              : 'Questions coming soon'
            : [c.notes ? `${c.notes} notes` : null, c.cards ? 'cards and memory map' : null]
                .filter(Boolean)
                .join(' · ') || 'Coming soon';
        return (
          <Pressable
            key={c.no}
            accessibilityRole="button"
            accessibilityLabel={`Chapter ${c.no}, ${c.title}`}
            disabled={!has}
            onPress={() => onOpen(c.no)}
            style={{
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.lg,
              padding: 14,
              gap: 6,
              opacity: has ? 1 : 0.6,
            }}
          >
            <Text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '700' }}>
              {c.no}. {c.title}
            </Text>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Pill label={`${c.marks} marks`} strong />
              <Pill label={`${c.share}% of the paper`} />
            </View>
            <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>{what}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
