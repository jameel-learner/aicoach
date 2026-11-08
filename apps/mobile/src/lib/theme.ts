import { fontSize, minTouchTarget, palette, radius, space } from '@aicoach/ui-tokens';
import { useColorScheme } from 'react-native';

export type Theme = (typeof palette)['light'] | (typeof palette)['dark'];

export function useTheme() {
  const scheme = useColorScheme();
  const colors: Theme = scheme === 'dark' ? palette.dark : palette.light;
  return { colors, space, radius, fontSize, minTouchTarget, dark: scheme === 'dark' };
}
