import {
  formatInr,
  isOpenSession,
  mathToText,
  type AssetSource,
  type SessionView,
  type ViewAction,
  type ViewBlock,
  type ViewCitation,
  type ViewForm,
} from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Pill } from '../../components/ChapterList';
import { Markdown } from '../../components/Markdown';
import { Body, Button, ErrorText, Heading, Screen, Title } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { actStream, getSession, type ActBody } from '../../lib/session';
import { useTheme } from '../../lib/theme';

/**
 * One study session (architecture §3.7). The server decides what each step shows; this screen
 * draws the blocks, buttons and text boxes it is sent. Closing the screen loses nothing: the
 * session is saved after every step and can be picked up from Home, also on another phone.
 */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { colors, fontSize } = useTheme();
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The coach's reply while it is being written. */
  const [typing, setTyping] = useState('');
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lastNode = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView((await getSession(id)).view);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  // A new step starts at its top; a reply within a step scrolls into sight.
  useEffect(() => {
    if (!view) return;
    const moved = lastNode.current !== view.node;
    lastNode.current = view.node;
    const t = setTimeout(
      () =>
        moved
          ? scroll.current?.scrollTo({ y: 0, animated: false })
          : scroll.current?.scrollToEnd({ animated: true }),
      50,
    );
    return () => clearTimeout(t);
  }, [view]);

  async function act(body: Omit<ActBody, 'seq'>) {
    if (!view || pending) return;
    setPending(true);
    setError(null);
    setTyping('');
    let reload = false;
    await actStream(view.sessionId, { ...body, seq: view.seq }, (e) => {
      if (e.type === 'delta') setTyping((t) => t + e.text);
      if (e.type === 'view') setView(e.view);
      if (e.type === 'error') {
        setError(e.message);
        if (e.view) setView(e.view);
        else reload = true;
      }
    });
    setTyping('');
    setPending(false);
    if (reload) await load();
    // Home, the chapter's mastery labels and the locker show what this step changed.
    void qc.invalidateQueries({ queryKey: ['study'] });
    void qc.invalidateQueries({ queryKey: ['learner', 'artefacts'] });
  }

  if (!view)
    return (
      <Screen>
        <Button title="‹ Back" variant="link" onPress={() => router.back()} />
        {error ? <ErrorText error={error} /> : <Body muted>Loading…</Body>}
      </Screen>
    );

  const open = isOpenSession(view.status);
  return (
    <Screen scroll={false}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button
          title={open ? '‹ Close (saved)' : '‹ Back'}
          variant="link"
          onPress={() => router.back()}
        />
        {view.progress.step > 0 && view.progress.of > 0 && (
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            {view.progress.label} · {view.progress.step} of {view.progress.of}
          </Text>
        )}
      </View>
      <ProgressBar step={view.progress.step} of={view.progress.of} />
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 14, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: 2 }}>
          <Title>{view.title}</Title>
          <Body muted>{view.subtitle}</Body>
        </View>
        {view.blocks.map((b, i) => (
          <Block key={`${view.seq}-${i}`} block={b} />
        ))}
        {pending && typing ? <ChatBubble role="coach" text={typing} /> : null}
        {pending && !typing ? <Body muted>Working…</Body> : null}
        <ErrorText error={error} />
        {view.forms.map((f) => (
          <Form
            key={`${view.seq}-${f.id}`}
            form={f}
            disabled={pending}
            onSubmit={(action, fields) => void act({ action, fields })}
          />
        ))}
        <Actions actions={view.actions} disabled={pending} onPress={(a) => void act(a)} />
        {!open && <Button title="Back to Home" onPress={() => router.back()} />}
        {view.billedMicro > 0 && (
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
            AI replies in this session: {formatInr(view.billedMicro)}
          </Text>
        )}
      </ScrollView>
    </Screen>
  );
}

function ProgressBar({ step, of }: { step: number; of: number }) {
  const { colors, radius } = useTheme();
  if (!of || step <= 0) return null;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: of, now: step }}
      style={{ height: 6, backgroundColor: colors.surfaceMuted, borderRadius: radius.pill }}
    >
      <View
        style={{
          height: 6,
          width: `${Math.min(100, Math.round((step / of) * 100))}%`,
          backgroundColor: colors.primary,
          borderRadius: radius.pill,
        }}
      />
    </View>
  );
}

function Actions({
  actions,
  disabled,
  onPress,
}: {
  actions: ViewAction[];
  disabled: boolean;
  onPress: (a: { action: string; value?: string | number }) => void;
}) {
  if (!actions.length) return null;
  return (
    <View style={{ gap: 8 }}>
      {actions.map((a, i) => (
        <Button
          key={`${a.id}-${i}`}
          title={mathToText(a.label)}
          variant={a.style}
          disabled={disabled}
          onPress={() => onPress({ action: a.id, value: a.value })}
        />
      ))}
    </View>
  );
}

function Form({
  form,
  disabled,
  onSubmit,
}: {
  form: ViewForm;
  disabled: boolean;
  onSubmit: (action: string, fields: Record<string, string>) => void;
}) {
  const { colors, fontSize, radius, minTouchTarget } = useTheme();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.name, f.value ?? ''])),
  );
  const empty = form.fields.some((f) => !(values[f.name] ?? '').trim());
  return (
    <View style={{ gap: 8 }}>
      {form.title ? <Heading>{form.title}</Heading> : null}
      {form.fields.map((f) => (
        <View key={f.name} style={{ gap: 4 }}>
          <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: '600' }}>
            {f.label}
          </Text>
          <TextInput
            accessibilityLabel={f.label}
            placeholder={f.placeholder}
            placeholderTextColor={colors.textMuted}
            multiline={!!f.multiline}
            value={values[f.name] ?? ''}
            onChangeText={(t) => setValues((v) => ({ ...v, [f.name]: t }))}
            style={{
              minHeight: f.multiline ? minTouchTarget * 2 : minTouchTarget,
              maxHeight: 200,
              textAlignVertical: f.multiline ? 'top' : 'center',
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
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {form.submits.map((s) => (
          <View key={s.action} style={{ flexGrow: 1 }}>
            <Button
              title={s.label}
              variant={s.style ?? 'primary'}
              // "Give me ideas" works with an empty box; everything else needs the learner's words.
              disabled={disabled || (empty && s.action !== 'ideas')}
              onPress={() => onSubmit(s.action, values)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function PageBadge({ page }: { page: number }) {
  const { colors, fontSize } = useTheme();
  return (
    <Text style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700' }}>
      {` p. ${page} `}
    </Text>
  );
}
const badgeFrom = (sources: (AssetSource | ViewCitation)[] | undefined) => (n: number) => {
  const s = sources?.find((x) => x.n === n);
  return s ? <PageBadge page={s.page} /> : null;
};

function ChatBubble({
  role,
  text,
  citations,
  flags,
}: {
  role: 'you' | 'coach';
  text: string;
  citations?: ViewCitation[];
  flags?: string[];
}) {
  const { colors, fontSize, radius } = useTheme();
  if (role === 'you')
    return (
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '90%',
          backgroundColor: colors.surfaceMuted,
          borderRadius: radius.md,
          padding: 10,
        }}
      >
        <Text style={{ color: colors.text, fontSize: fontSize.md }}>{text}</Text>
      </View>
    );
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: 12,
        gap: 6,
      }}
    >
      <Markdown text={text} renderCitation={badgeFrom(citations)} />
      {(flags ?? []).map((f) => (
        <Text key={f} style={{ color: colors.warning, fontSize: fontSize.sm }}>
          ⚠ {f}
        </Text>
      ))}
    </View>
  );
}

/** Counts up from where the server says the clock is. */
function Timer({ elapsedMs, targetMinutes }: { elapsedMs: number; targetMinutes: number }) {
  const { colors, fontSize } = useTheme();
  const [started] = useState(() => Date.now() - elapsedMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - started) / 1000));
  const over = s > targetMinutes * 60;
  return (
    <View style={{ alignItems: 'center', gap: 4, paddingVertical: 12 }}>
      <Text
        accessibilityRole="timer"
        style={{
          color: over ? colors.warning : colors.text,
          fontSize: fontSize['3xl'],
          fontWeight: '700',
          fontVariant: ['tabular-nums'],
        }}
      >
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
        The paper allows about {targetMinutes} min
      </Text>
    </View>
  );
}

function Block({ block: b }: { block: ViewBlock }) {
  const { colors, fontSize, radius } = useTheme();
  switch (b.type) {
    case 'heading':
      return <Heading>{mathToText(b.text)}</Heading>;
    case 'text':
      return <Body muted={b.muted}>{mathToText(b.text)}</Body>;
    case 'markdown':
      return <Markdown text={b.text} renderCitation={badgeFrom(b.sources)} />;
    case 'badges':
      return (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {b.items.map((x) => (
            <Pill key={x.label} label={x.label} strong={x.strong} />
          ))}
        </View>
      );
    case 'callout': {
      const edge = {
        info: colors.border,
        success: colors.accent,
        warning: colors.warning,
        safety: colors.primary,
      }[b.tone];
      return (
        <View
          accessibilityRole={b.tone === 'safety' ? 'alert' : undefined}
          style={{
            backgroundColor: colors.surface,
            borderColor: edge,
            borderWidth: b.tone === 'info' ? 1 : 2,
            borderRadius: radius.md,
            padding: 12,
            gap: 4,
          }}
        >
          {b.title ? (
            <Text style={{ color: colors.text, fontSize: fontSize.md, fontWeight: '700' }}>
              {b.title}
            </Text>
          ) : null}
          <Text style={{ color: colors.text, fontSize: fontSize.md, lineHeight: 24 }}>
            {mathToText(b.text)}
          </Text>
        </View>
      );
    }
    case 'chat':
      return <ChatBubble role={b.role} text={b.text} citations={b.citations} flags={b.flags} />;
    case 'card':
      return (
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>{b.label}</Text>
          <View
            style={{
              minHeight: 140,
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              padding: 16,
              gap: 12,
              backgroundColor: colors.surface,
            }}
          >
            <Text style={{ color: colors.text, fontSize: fontSize.lg, textAlign: 'center' }}>
              {mathToText(b.front)}
            </Text>
            {b.back !== undefined && (
              <Text
                style={{
                  color: colors.text,
                  fontSize: fontSize.lg,
                  fontWeight: '700',
                  textAlign: 'center',
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  paddingTop: 12,
                }}
              >
                {mathToText(b.back)}
              </Text>
            )}
          </View>
        </View>
      );
    case 'list':
      return (
        <View style={{ gap: 4 }}>
          {b.items.map((x) => (
            <Text key={x} style={{ color: colors.text, fontSize: fontSize.md, lineHeight: 24 }}>
              • {mathToText(x)}
            </Text>
          ))}
        </View>
      );
    case 'timer':
      return <Timer elapsedMs={b.elapsedMs} targetMinutes={b.targetMinutes} />;
  }
}
