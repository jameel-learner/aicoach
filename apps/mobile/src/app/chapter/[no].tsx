import {
  MASTERY_LABELS,
  mathToText,
  stripCitations,
  type AssetSource,
  type CardsDraft,
  type GeneratedQuestion,
  type StoredNote,
} from '@aicoach/core';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { OfflineNote, Pill } from '../../components/ChapterList';
import { Markdown } from '../../components/Markdown';
import { Body, Button, Card, Choice, ErrorText, Heading, Screen, Title } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useEnrolment } from '../../lib/enrolment-context';
import { useChapter, type Asset, type ChapterMaterial } from '../../lib/material';
import { startSession, useTopicLevels } from '../../lib/session';
import { useTheme } from '../../lib/theme';

type Tab = 'notes' | 'cards' | 'questions';

/** One chapter: notes (exam answer + understand it), memory map + cards, practice questions. */
export default function ChapterScreen() {
  const { no, tab: initial } = useLocalSearchParams<{ no: string; tab?: Tab }>();
  const router = useRouter();
  const { active } = useEnrolment();
  const chapter = useChapter(active?.id, Number(no));
  const [tab, setTab] = useState<Tab>(initial ?? 'notes');
  const d = chapter.data;

  return (
    <Screen>
      <Button title="‹ Back" variant="link" onPress={() => router.back()} />
      {chapter.error && <ErrorText error={errorMessage(chapter.error)} />}
      {!d && !chapter.error && <Body muted>Loading…</Body>}
      {d && (
        <>
          <Title>
            {d.chapter.no}. {d.chapter.title}
          </Title>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Pill label={`${d.chapter.marks} marks in the paper`} strong />
          </View>
          {d.offline && <OfflineNote />}
          <Choice
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'notes', label: `Notes (${d.notes.length})` },
              { value: 'cards', label: 'Cards' },
              { value: 'questions', label: 'Questions' },
            ]}
          />
          {tab === 'notes' && <Notes d={d} />}
          {tab === 'cards' && (
            <>
              {d.cards && !d.offline && <StartSession journey="memorise" chapter={d.chapter.no} />}
              <Cards cards={d.cards} />
            </>
          )}
          {tab === 'questions' && <Questions sets={d.questions} />}
        </>
      )}
    </Screen>
  );
}

/** [S#] → a small "p. 65" badge from the asset's sources. */
function usePageBadge(sources: AssetSource[]) {
  const { colors, fontSize } = useTheme();
  return (n: number) => {
    const s = sources.find((x) => x.n === n);
    if (!s) return null;
    return (
      <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700' }}>
        {` p. ${s.page} `}
      </Text>
    );
  };
}

/**
 * Opens a study session (Phase 4): step by step through one topic, or today's cards of the chapter.
 * Students only; an open session for the same topic is resumed.
 */
function StartSession({
  journey,
  chapter,
  topic,
}: {
  journey: 'explain' | 'memorise';
  chapter: number;
  topic?: string;
}) {
  const router = useRouter();
  const { active } = useEnrolment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (active?.roleIn !== 'student') return null;
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { view } = await startSession({ journey, enrolmentId: active?.id, chapter, topic });
      router.push(`/session/${view.sessionId}` as Href);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 4 }}>
      <Button
        title={journey === 'explain' ? 'Learn this step by step (8 min)' : "Practise today's cards"}
        variant={journey === 'explain' ? 'secondary' : 'primary'}
        loading={busy}
        onPress={() => void go()}
      />
      <ErrorText error={error} />
    </View>
  );
}

function Notes({ d }: { d: ChapterMaterial }) {
  const { colors, fontSize } = useTheme();
  const { active } = useEnrolment();
  const levels = useTopicLevels(active?.roleIn === 'student' ? active.id : undefined);
  if (!d.notes.length) return <Body muted>No notes for this chapter yet.</Body>;
  const topics = [...new Set(d.notes.map((n) => n.topic))];
  const levelOf = (t: string) =>
    levels.data?.topics.find((x) => x.chapter === d.chapter.no && x.topic === t)?.level ?? 0;
  return (
    <View style={{ gap: 16 }}>
      {topics.map((t) => {
        const pre = d.prerequisites[t] ?? [];
        return (
          <View key={t} style={{ gap: 8 }}>
            <Heading>{t}</Heading>
            {levelOf(t) > 0 && <Pill label={`You: ${MASTERY_LABELS[levelOf(t)]}`} />}
            {pre.length > 0 && (
              <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                Learn first:{' '}
                {pre
                  .map((p) =>
                    p.chapter === d.chapter.no ? p.topic : `${p.topic} (ch. ${p.chapter})`,
                  )
                  .join(', ')}
              </Text>
            )}
            {d.notes
              .filter((n) => n.topic === t)
              .map((n) => (
                <NoteCard key={n.id} note={n} />
              ))}
            {!d.offline && <StartSession journey="explain" chapter={d.chapter.no} topic={t} />}
          </View>
        );
      })}
    </View>
  );
}

function NoteCard({ note }: { note: Asset<StoredNote> }) {
  const { colors, fontSize, radius } = useTheme();
  const [open, setOpen] = useState(false);
  const n = note.content;
  const cite = usePageBadge(note.sources);
  const ex = n.examAnswer;
  const legacy = !ex && n.workedExample ? n.workedExample : null;
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ gap: 6 }}
      >
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Pill label={`${note.marks} mark${note.marks === 1 ? '' : 's'}`} strong />
          {ex?.minutes ? <Pill label={`${ex.minutes} min`} /> : null}
        </View>
        <Text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '700' }}>
          {n.title}
        </Text>
        <Markdown text={n.summary} renderCitation={cite} />
        <Text style={{ color: colors.primary, fontWeight: '600' }}>
          {open ? 'Hide' : 'Open the note'}
        </Text>
      </Pressable>
      {open && (
        <View style={{ gap: 12 }}>
          {ex && (
            <View
              style={{
                borderWidth: 2,
                borderColor: colors.primary,
                borderRadius: radius.md,
                padding: 10,
                gap: 6,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>
                Write this in the exam{ex.marksSplit ? ` · marks ${ex.marksSplit}` : ''}
              </Text>
              <Markdown text={`**${ex.question}**`} renderCitation={cite} />
              <Markdown text={ex.answer} renderCitation={cite} />
            </View>
          )}
          <Text style={{ color: colors.text, fontWeight: '700' }}>
            Understand it <Text style={{ color: colors.textMuted }}>(read, don't memorise)</Text>
          </Text>
          {n.sections.map((s) => (
            <View key={s.heading} style={{ gap: 4 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>{s.heading}</Text>
              <Markdown text={s.body} renderCitation={cite} />
            </View>
          ))}
          {legacy && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>Worked example</Text>
              <Markdown text={legacy.question} renderCitation={cite} />
              <Markdown text={legacy.solution} renderCitation={cite} />
            </View>
          )}
          {n.keyTerms.length > 0 && (
            <Body>
              <Text style={{ fontWeight: '700' }}>Key terms: </Text>
              {n.keyTerms.join(' · ')}
            </Body>
          )}
          {n.examTips.length > 0 && <Markdown text={n.examTips.map((t) => `- ${t}`).join('\n')} />}
          <Body muted>
            Why this matters: {n.whyThisMatters.exam} {n.whyThisMatters.realWorld}
          </Body>
        </View>
      )}
    </Card>
  );
}

function Cards({ cards }: { cards: Asset<CardsDraft> | null }) {
  const { colors, fontSize, radius } = useTheme();
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  if (!cards) return <Body muted>No cards for this chapter yet.</Body>;
  const c = cards.content;
  const card = c.cards[Math.min(i, c.cards.length - 1)];
  const go = (to: number) => {
    setI((to + c.cards.length) % c.cards.length);
    setFlipped(false);
  };
  return (
    <View style={{ gap: 16 }}>
      <Card>
        <Heading>Memory map</Heading>
        <Text
          style={{
            color: colors.text,
            fontSize: fontSize.md,
            fontWeight: '700',
            textAlign: 'center',
          }}
        >
          {c.map.center}
        </Text>
        {c.map.branches.map((b) => (
          <View
            key={b.label}
            style={{ backgroundColor: colors.surfaceMuted, borderRadius: radius.md, padding: 10 }}
          >
            <Text style={{ color: colors.text, fontWeight: '700' }}>{b.label}</Text>
            {b.points.map((p) => (
              <Text key={p} style={{ color: colors.text }}>
                • {mathToText(p)}
              </Text>
            ))}
          </View>
        ))}
      </Card>
      {card && (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            Card {Math.min(i, c.cards.length - 1) + 1} of {c.cards.length} · {card.topic}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={flipped ? 'Show the question' : 'Show the answer'}
            onPress={() => setFlipped(!flipped)}
            style={{
              minHeight: 160,
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              padding: 16,
              backgroundColor: flipped ? colors.surfaceMuted : colors.surface,
            }}
          >
            <Text style={{ color: colors.text, fontSize: fontSize.lg, textAlign: 'center' }}>
              {mathToText(stripCitations(flipped ? card.back : card.front))}
            </Text>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: fontSize.xs,
                textAlign: 'center',
                marginTop: 8,
              }}
            >
              {flipped ? 'Tap to see the question' : 'Tap to see the answer'}
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Button title="‹ Previous" variant="link" onPress={() => go(i - 1)} />
            <Button title="Next ›" variant="link" onPress={() => go(i + 1)} />
          </View>
        </Card>
      )}
    </View>
  );
}

const TYPE: Record<string, string> = {
  mcq: 'MCQ',
  fill_blank: 'Fill in the blank',
  match: 'Match',
  very_short: 'Very short',
  expand: 'Expand',
  true_false: 'True / false',
  short_answer: 'Short answer',
  problem: 'Problem',
};

function Questions({ sets }: { sets: ChapterMaterial['questions'] }) {
  if (!sets.length) return <Body muted>No practice questions for this chapter yet.</Body>;
  return (
    <View style={{ gap: 16 }}>
      {sets.map((s) => (
        <View key={s.id} style={{ gap: 8 }}>
          <Heading>
            {s.marks}-mark questions ({s.content.questions.length})
          </Heading>
          {s.content.questions.map((q, k) => (
            <QuestionCard key={k} n={k + 1} q={q} sources={s.sources} />
          ))}
        </View>
      ))}
    </View>
  );
}

function QuestionCard({
  n,
  q,
  sources,
}: {
  n: number;
  q: GeneratedQuestion;
  sources: AssetSource[];
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const cite = usePageBadge(sources);
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Pill label={`Q${n}`} strong />
        <Pill label={TYPE[q.typology] ?? q.typology} />
        <Pill label={q.difficulty === 'hots' ? 'HOTS' : q.difficulty} />
      </View>
      <Markdown text={q.question} />
      {q.options && (
        <View>
          {q.options.map((o, k) => (
            <Text key={o} style={{ color: colors.text }}>
              ({String.fromCharCode(97 + k)}) {mathToText(o).replace(/^\(?[a-d][).]\s*/i, '')}
            </Text>
          ))}
        </View>
      )}
      <Button
        title={open ? 'Hide the answer' : 'Try it, then show the answer'}
        variant="link"
        onPress={() => setOpen(!open)}
      />
      {open && (
        <View style={{ gap: 6 }}>
          <Markdown text={q.answer} renderCitation={cite} />
          {q.markingPoints.length > 0 && (
            <Markdown
              text={`**Marks are given for:**\n${q.markingPoints.map((m) => `- ${m.point} (${m.marks})`).join('\n')}`}
            />
          )}
        </View>
      )}
    </Card>
  );
}
