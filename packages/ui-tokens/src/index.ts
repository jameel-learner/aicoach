/**
 * Shared design tokens for the web app and the mobile app.
 * Calm, high-contrast, exam-focused. Colour pairs meet WCAG AA for body text in both themes.
 */

export const palette = {
  light: {
    bg: '#F7F8FA',
    surface: '#FFFFFF',
    surfaceMuted: '#EEF1F5',
    border: '#D8DEE6',
    text: '#14181F',
    textMuted: '#55606E',
    primary: '#1F5FBF',
    primaryText: '#FFFFFF',
    accent: '#0F8A6A',
    warning: '#A35A00',
    danger: '#B42318',
    focus: '#7AA7F0',
  },
  dark: {
    bg: '#0E1116',
    surface: '#161B22',
    surfaceMuted: '#1F2630',
    border: '#2E3744',
    text: '#E8ECF2',
    textMuted: '#9AA6B5',
    primary: '#6EA2F5',
    primaryText: '#0B1220',
    accent: '#3CC79F',
    warning: '#F0A63A',
    danger: '#F27A6E',
    focus: '#3B6CC4',
  },
} as const;

export type ThemeName = keyof typeof palette;
export type ColorToken = keyof (typeof palette)['light'];

/** 4-pt spacing scale. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

/** Type scale (px). Minimum body 16 for readability on mid-range phones. */
export const fontSize = { xs: 13, sm: 14, md: 16, lg: 18, xl: 22, '2xl': 28, '3xl': 34 } as const;

/** Minimum touch target (Android guidance: 48dp). */
export const minTouchTarget = 48;

/** CSS custom properties for the web app, e.g. `--color-primary`. */
export function cssVariables(theme: ThemeName): string {
  return Object.entries(palette[theme])
    .map(([k, v]) => `--color-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v};`)
    .join('\n');
}
