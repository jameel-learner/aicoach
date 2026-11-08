import { Pressable, Text, View } from 'react-native';
import { useEnrolment } from '../lib/enrolment-context';
import { useTheme } from '../lib/theme';

/** Horizontal chips to switch between the learner's classes/subjects (spec 4.2.1). */
export function EnrolmentSwitcher() {
  const { enrolments, active, setActive } = useEnrolment();
  const { colors, radius, minTouchTarget } = useTheme();
  if (enrolments.length < 2) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="tablist">
      {enrolments.map((e) => {
        const selected = e.id === active?.id;
        return (
          <Pressable
            key={e.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => setActive(e.id)}
            style={{
              minHeight: minTouchTarget,
              paddingHorizontal: 14,
              justifyContent: 'center',
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: selected ? colors.primary : colors.border,
              backgroundColor: selected ? colors.primary : colors.surface,
            }}
          >
            <Text style={{ color: selected ? colors.primaryText : colors.text, fontWeight: '600' }}>
              {e.offering.subject}
              {e.classGroup ? ` · ${e.classGroup.name}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
