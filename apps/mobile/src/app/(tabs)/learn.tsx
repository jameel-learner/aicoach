import { formatInr } from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, ErrorText, Heading, Screen, Title } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { api, errorMessage } from '../../lib/api';
import { askStream, type Citation, type DoneEvent } from '../../lib/ask';
import { useEnrolment } from '../../lib/enrolment-context';
import { useTheme } from '../../lib/theme';

interface Turn {
  id: number;
  question: string;
  text: string;
  done?: DoneEvent;
  error?: string;
  pending: boolean;
}

/** Learn tab: "Ask your textbook" (spec 1.1–1.4). Answer first, streamed, with page citations. */
export default function Learn() {
  const { colors, fontSize, radius, minTouchTarget } = useTheme();
  const { active } = useEnrolment();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const scope = useQuery({
    queryKey: ['ask', 'scope', active?.id],
    queryFn: () =>
      api<{ books: { id: string; title: string }[] }>(
        `/ask/scope${active ? `?enrolmentId=${active.id}` : ''}`,
      ),
    retry: false,
  });
  const busy = turns.some((t) => t.pending);
  const update = (id: number, fn: (t: Turn) => Turn) =>
    setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  async function ask(q: string, forceNew = false) {
    const id = Date.now();
    setTurns((all) => [...all, { id, question: q, text: '', pending: true }]);
    await askStream({ question: q, forceNew, enrolmentId: active?.id }, (e) => {
      if (e.type === 'delta') update(id, (t) => ({ ...t, text: t.text + e.text }));
      if (e.type === 'done') update(id, (t) => ({ ...t, done: e, text: e.answer, pending: false }));
      if (e.type === 'error') update(id, (t) => ({ ...t, error: e.message, pending: false }));
    });
    update(id, (t) => ({ ...t, pending: false }));
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }

  return (
    <Screen scroll={false}>
      <Title>Ask your textbook</Title>
      <Body muted>
        {scope.error
          ? errorMessage(scope.error)
          : scope.data
            ? `Searching: ${scope.data.books.map((b) => b.title).join(', ')}`
            : 'Loading…'}
      </Body>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 16, paddingBottom: 8 }}
      >
        {turns.length === 0 && (
          <Card>
            <Heading>Ask anything from your textbook</Heading>
            <Body muted>
              Answers come only from your book and show the page they're from. Try “What is
              goodwill?”
            </Body>
          </Card>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} busy={busy} onRetry={() => void ask(t.question, true)} />
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <TextInput
          accessibilityLabel="Your question"
          placeholder="Type your question…"
          placeholderTextColor={colors.textMuted}
          multiline
          value={question}
          onChangeText={setQuestion}
          style={{
            flex: 1,
            minHeight: minTouchTarget,
            maxHeight: 120,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            backgroundColor: colors.surface,
            color: colors.text,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: fontSize.md,
          }}
        />
        <Button
          title="Ask"
          disabled={busy || question.trim().length < 3}
          onPress={() => {
            const q = question.trim();
            setQuestion('');
            void ask(q);
          }}
        />
      </View>
    </Screen>
  );
}

function TurnView({ turn, busy, onRetry }: { turn: Turn; busy: boolean; onRetry: () => void }) {
  const { colors, fontSize, radius } = useTheme();
  const [cite, setCite] = useState<Citation | null>(null);
  const d = turn.done;
  const citations = d?.citations ?? [];
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '90%',
          backgroundColor: colors.surfaceMuted,
          borderRadius: radius.md,
          padding: 10,
        }}
      >
        <Text style={{ color: colors.text, fontSize: fontSize.md }}>{turn.question}</Text>
      </View>
      {turn.error ? (
        <ErrorText error={turn.error} />
      ) : (
        <Card>
          {d?.notInBook && (
            <Text style={{ color: colors.warning, fontWeight: '700' }}>⚠ Not in your textbook</Text>
          )}
          <Markdown
            text={d ? d.answer : turn.text || '…'}
            renderCitation={(n) => {
              const c = citations.find((x) => x.n === n);
              if (!c) return null;
              return (
                <Text
                  accessibilityRole="button"
                  accessibilityLabel={`Source: page ${c.page}`}
                  onPress={() => setCite(c)}
                  style={{
                    color: c.supported ? colors.primaryText : colors.text,
                    backgroundColor: c.supported ? colors.primary : 'transparent',
                    fontSize: fontSize.xs,
                    fontWeight: '700',
                  }}
                >
                  {` p. ${c.page} `}
                </Text>
              );
            }}
          />
          {cite && (
            <Pressable
              onPress={() => setCite(null)}
              style={{ backgroundColor: colors.surfaceMuted, borderRadius: radius.sm, padding: 10 }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>
                {cite.bookTitle} · page {cite.page}
                {cite.section ? ` · ${cite.section}` : ''}
              </Text>
              <Text style={{ color: colors.textMuted, marginTop: 4 }}>{cite.snippet}…</Text>
            </Pressable>
          )}
          {d && (
            <View style={{ gap: 4 }}>
              {d.uncertain && !d.notInBook && (
                <Text style={{ color: colors.warning, fontSize: fontSize.sm }}>
                  ⚠ Check with your textbook: some points aren't clearly backed by it
                </Text>
              )}
              <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                {d.cached ? 'Saved answer · free' : formatInr(d.billedMicro)}
              </Text>
              <Button title="Get a new answer" variant="link" disabled={busy} onPress={onRetry} />
            </View>
          )}
        </Card>
      )}
    </View>
  );
}
