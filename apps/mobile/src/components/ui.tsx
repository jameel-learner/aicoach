import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';

/** Vertical, thumb-friendly screen: scrolls, avoids the keyboard, respects safe areas. */
export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { colors, space } = useTheme();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={{ padding: space[4], gap: space[4] }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1, padding: space[4], gap: space[4] }}>{children}</View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const { colors, fontSize } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: colors.text, fontSize: fontSize['2xl'], fontWeight: '700' }}
    >
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const { colors, fontSize } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: colors.text, fontSize: fontSize.lg, fontWeight: '600' }}
    >
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const { colors, fontSize } = useTheme();
  return (
    <Text
      style={{
        color: muted ? colors.textMuted : colors.text,
        fontSize: fontSize.md,
        lineHeight: 24,
      }}
    >
      {children}
    </Text>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  const { colors, fontSize } = useTheme();
  if (!error) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: fontSize.sm }}>
      {error}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  loading,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'link';
}) {
  const { colors, radius, minTouchTarget, fontSize } = useTheme();
  const isDisabled = disabled || loading;
  if (variant === 'link') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        disabled={isDisabled}
        hitSlop={8}
        style={{ minHeight: minTouchTarget, justifyContent: 'center' }}
      >
        <Text
          style={{
            color: colors.primary,
            fontSize: fontSize.md,
            fontWeight: '600',
            textAlign: 'center',
          }}
        >
          {title}
        </Text>
      </Pressable>
    );
  }
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => ({
        minHeight: minTouchTarget,
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        backgroundColor: primary ? colors.primary : colors.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.border,
        opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.primaryText : colors.text} />
      ) : (
        <Text
          style={{
            color: primary ? colors.primaryText : colors.text,
            fontSize: fontSize.md,
            fontWeight: '600',
          }}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function TextField({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const { colors, radius, minTouchTarget, fontSize } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: '600' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        {...props}
        style={[
          {
            minHeight: minTouchTarget,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            color: colors.text,
            paddingHorizontal: 12,
            fontSize: fontSize.md,
          },
          props.style,
        ]}
      />
      {hint ? <Text style={{ color: colors.textMuted, fontSize: fontSize.sm }}>{hint}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { colors, radius, space } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: space[4],
          gap: space[3],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Pill-style single choice, e.g. role or relationship. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors, radius, fontSize, minTouchTarget } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.text, fontSize: fontSize.sm, fontWeight: '600' }}>{label}</Text>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
        accessibilityRole="radiogroup"
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.value)}
              style={{
                minHeight: minTouchTarget,
                paddingHorizontal: 16,
                justifyContent: 'center',
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? colors.primary : colors.surface,
              }}
            >
              <Text
                style={{
                  color: selected ? colors.primaryText : colors.text,
                  fontSize: fontSize.md,
                  fontWeight: '600',
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Centered({ children }: { children?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bg,
      }}
    >
      {children ?? <ActivityIndicator color={colors.primary} size="large" />}
    </View>
  );
}
