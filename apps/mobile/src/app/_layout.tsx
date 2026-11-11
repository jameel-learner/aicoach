import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Body, Button, Centered } from '../components/ui';
import { useMe } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { EnrolmentProvider } from '../lib/enrolment-context';
import { useTheme } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

/**
 * Auth-aware navigator.
 *
 * Important: once the first session check has finished, the <Stack> must stay mounted.
 * Better Auth sets `isPending` back to true on every session re-check while signed out
 * (e.g. right after the password step of sign-in). Unmounting the Stack at that moment
 * throws away navigation state, so loading/error states are shown as an overlay instead.
 */
function RootNavigator() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = !!session?.user;
  const me = useMe(signedIn);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    if (!booted && !isPending) {
      setBooted(true);
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [booted, isPending]);

  if (!booted) return <Centered />;

  // Until /me has loaded we don't know whether onboarding is needed; keep the auth screens
  // mounted underneath an overlay so the current screen (e.g. "Enter your code") isn't lost.
  const meReady = signedIn && !!me.data;
  const ob = me.data?.onboarding;
  const needsOnboarding = meReady && !!ob && (ob.needsParentContact || ob.needsEnrolment);
  const showLoading = signedIn && !me.data && me.isLoading;
  const showError = signedIn && !me.data && !!me.error;

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!meReady}>
          <Stack.Screen name="sign-in" />
          <Stack.Screen name="sign-up" />
          <Stack.Screen name="verify" />
        </Stack.Protected>
        <Stack.Protected guard={needsOnboarding}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected guard={meReady && !needsOnboarding}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="join-class" options={{ presentation: 'modal' }} />
          <Stack.Screen name="chapter/[no]" />
        </Stack.Protected>
      </Stack>
      {(showLoading || showError) && (
        <View style={StyleSheet.absoluteFill}>
          {showError ? (
            <Centered>
              <Body muted>Couldn't load your account. Check your connection.</Body>
              <Button title="Try again" variant="link" onPress={() => void me.refetch()} />
            </Centered>
          ) : (
            <Centered />
          )}
        </View>
      )}
    </View>
  );
}

export default function RootLayout() {
  const { dark } = useTheme();
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
          <EnrolmentProvider>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <RootNavigator />
          </EnrolmentProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
