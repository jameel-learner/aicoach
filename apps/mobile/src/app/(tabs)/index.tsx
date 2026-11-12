import { JOURNEY_LABELS } from '@aicoach/core';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Pill } from '../../components/ChapterList';
import { EnrolmentSwitcher } from '../../components/EnrolmentSwitcher';
import { Body, Button, Card, ErrorText, Heading, Screen, Title } from '../../components/ui';
import { errorMessage, useMe } from '../../lib/api';
import { useEnrolment } from '../../lib/enrolment-context';
import { startSession, useStudyHome, type Suggestion } from '../../lib/session';
import { useTheme } from '../../lib/theme';

export default function Home() {
  const { data: me } = useMe();
  const { active } = useEnrolment();
  if (!me) return null;
  const firstName = me.user.name.split(' ')[0];

  if (me.user.role === 'admin' || me.user.role === 'institution_poc') {
    return (
      <Screen>
        <Title>Hi {firstName}</Title>
        <Card>
          <Body>
            Institution and admin tools are in the AI Coach web app. Sign in there with the same
            email.
          </Body>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Hi {firstName}</Title>
      <EnrolmentSwitcher />
      {active && (
        <Card>
          <Heading>{active.offering.subject}</Heading>
          <Body muted>
            {active.offering.board} · {active.offering.level}
            {active.institution ? ` · ${active.institution.name}` : ' · self-study'}
            {active.classGroup ? ` · ${active.classGroup.name}` : ''}
          </Body>
        </Card>
      )}
      {me.user.role === 'student' ? (
        <Study enrolmentId={active?.id} />
      ) : (
        <Card>
          <Heading>Study sessions are for students</Heading>
          <Body muted>
            You can read the notes, cards and questions under Learn and Practice, and ask your
            textbook. Teaching tools come in a later version.
          </Body>
        </Card>
      )}
    </Screen>
  );
}

/** One-tap resume, what to do next, and honest progress (architecture §6.1). */
function Study({ enrolmentId }: { enrolmentId: string | undefined }) {
  const router = useRouter();
  const { colors, fontSize, radius } = useTheme();
  const home = useStudyHome(enrolmentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function begin(s: Suggestion) {
    const key = `${s.journey}-${s.chapter}-${s.topic ?? ''}`;
    setBusy(key);
    setError(null);
    try {
      const { view } = await startSession({
        journey: s.journey,
        enrolmentId,
        chapter: s.chapter,
        topic: s.topic,
      });
      router.push(`/session/${view.sessionId}` as Href);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (home.error) return <ErrorText error={errorMessage(home.error)} />;
  if (!home.data) return <Body muted>Loading…</Body>;
  const d = home.data;
  if (!d.ready)
    return (
      <Card>
        <Heading>Your study sessions will appear here</Heading>
        <Body muted>
          Short 7 to 12 minute units, each with a clear finish, that you can pause and pick up again
          with one tap. They start as soon as your subject&apos;s material has been checked.
        </Body>
      </Card>
    );
  const p = d.progress;
  return (
    <>
      {d.resume && (
        <Card style={{ borderColor: colors.primary, borderWidth: 2 }}>
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            {d.resume.status === 'paused' ? 'Paused' : 'In progress'} ·{' '}
            {JOURNEY_LABELS[d.resume.journey]}
          </Text>
          <Heading>{d.resume.title}</Heading>
          <Button
            title="Continue where you stopped"
            onPress={() => router.push(`/session/${d.resume!.id}` as Href)}
          />
        </Card>
      )}

      <Card>
        <Heading>{d.resume ? 'Or start something else' : 'Next up'}</Heading>
        <Body muted>About 8 minutes each. Stop at any step: it is saved.</Body>
        <ErrorText error={error} />
        {d.suggestions.length === 0 && (
          <Body muted>
            Nothing is waiting. Open a chapter under Learn to study any topic again.
          </Body>
        )}
        {d.suggestions.map((s) => {
          const key = `${s.journey}-${s.chapter}-${s.topic ?? ''}`;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${JOURNEY_LABELS[s.journey]}: ${s.title}`}
              disabled={busy !== null}
              onPress={() => void begin(s)}
              style={{
                backgroundColor: colors.surfaceMuted,
                borderRadius: radius.md,
                padding: 12,
                gap: 4,
                opacity: busy && busy !== key ? 0.5 : 1,
              }}
            >
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <Pill label={JOURNEY_LABELS[s.journey]} strong />
                <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                  Chapter {s.chapter}
                </Text>
              </View>
              <Text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '700' }}>
                {s.title}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                {busy === key ? 'Opening…' : s.reason}
              </Text>
            </Pressable>
          );
        })}
      </Card>

      <Card>
        <Heading>Where you are</Heading>
        <Body>
          {p.topics.gotIt} topic{p.topics.gotIt === 1 ? '' : 's'} understood
          {p.topics.started > p.topics.gotIt
            ? `, ${p.topics.started - p.topics.gotIt} more started`
            : ''}
          .
        </Body>
        <Body>
          {p.cards.known} card{p.cards.known === 1 ? '' : 's'} remembered after 3 days or more,{' '}
          {p.cards.reviewed} reviewed in all, {p.cards.due} due now.
        </Body>
        <Body muted>
          {p.daysStudied} day{p.daysStudied === 1 ? '' : 's'} studied, {p.sessionsFinished} session
          {p.sessionsFinished === 1 ? '' : 's'} finished. Only you can see this.
        </Body>
      </Card>
    </>
  );
}
