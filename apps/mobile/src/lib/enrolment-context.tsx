import type { EnrolmentView } from '@aicoach/core';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useMe } from './api';

const KEY = 'aicoach_active_enrolment';

interface Ctx {
  enrolments: EnrolmentView[];
  active: EnrolmentView | null;
  setActive: (id: string) => void;
}

const EnrolmentContext = createContext<Ctx>({ enrolments: [], active: null, setActive: () => {} });

/** Which enrolment (institution × class × subject) the learner is currently studying in (spec 4.2.1). */
export function EnrolmentProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  // Memoised: a fresh [] each render would change the context value and re-render every consumer.
  const enrolments = useMemo(() => me?.enrolments ?? [], [me?.enrolments]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((v) => setActiveId(v))
      .catch(() => {});
  }, []);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    SecureStore.setItemAsync(KEY, id).catch(() => {});
  }, []);

  const value = useMemo<Ctx>(() => {
    const active = enrolments.find((e) => e.id === activeId) ?? enrolments[0] ?? null;
    return { enrolments, active, setActive };
  }, [enrolments, activeId, setActive]);

  return <EnrolmentContext.Provider value={value}>{children}</EnrolmentContext.Provider>;
}

export const useEnrolment = () => useContext(EnrolmentContext);
