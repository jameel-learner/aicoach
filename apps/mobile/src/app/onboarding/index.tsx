import { Redirect } from 'expo-router';
import { Centered } from '../../components/ui';
import { useMe } from '../../lib/api';

/** Sends the user to the next onboarding step they still need. */
export default function OnboardingIndex() {
  const { data: me } = useMe();
  if (!me) return <Centered />;
  if (me.onboarding.needsParentContact) return <Redirect href="/onboarding/parent" />;
  return <Redirect href="/onboarding/enrol" />;
}
