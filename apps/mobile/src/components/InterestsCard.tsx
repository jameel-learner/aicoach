import { MAX_INTERESTS } from '@aicoach/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api, errorMessage } from '../lib/api';
import { useInterests } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Body, Card, ErrorText, Heading } from './ui';

/**
 * Declared interests (spec 5.5.11): the learner picks them, nothing is worked out from what they do.
 * The coach may use them for a comparison or a memory hook. Saved on every tap.
 */
export function InterestsCard() {
  const { colors, radius, fontSize, minTouchTarget } = useTheme();
  const qc = useQueryClient();
  const { data } = useInterests();
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const chosen = data.interests;

  async function toggle(name: string) {
    const next = chosen.includes(name) ? chosen.filter((x) => x !== name) : [...chosen, name];
    if (next.length > MAX_INTERESTS) return setError(`Choose up to ${MAX_INTERESTS}.`);
    setError(null);
    // Show the change at once; put it back if saving fails.
    qc.setQueryData(['learner', 'interests'], { ...data, interests: next });
    try {
      await api('/learner/interests', { method: 'PUT', body: { interests: next } });
    } catch (e) {
      qc.setQueryData(['learner', 'interests'], data);
      setError(errorMessage(e));
    }
  }

  return (
    <Card>
      <Heading>What I like</Heading>
      <Body muted>
        Pick up to {MAX_INTERESTS}. Your coach can use them for examples and memory hooks. We only
        use what you choose here.
      </Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {data.options.map((o) => {
          const on = chosen.includes(o);
          return (
            <Pressable
              key={o}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => void toggle(o)}
              style={{
                minHeight: minTouchTarget,
                paddingHorizontal: 14,
                justifyContent: 'center',
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: on ? colors.primary : colors.border,
                backgroundColor: on ? colors.primary : colors.surface,
              }}
            >
              <Text
                style={{
                  color: on ? colors.primaryText : colors.text,
                  fontSize: fontSize.md,
                  fontWeight: '600',
                }}
              >
                {o}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ErrorText error={error} />
    </Card>
  );
}
