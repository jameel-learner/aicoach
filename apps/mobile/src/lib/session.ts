import type {
  ArtefactKind,
  JourneyId,
  SessionEvent,
  SessionStatus,
  SessionView,
} from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { fetch as expoFetch } from 'expo/fetch';
import { api } from './api';
import { authClient } from './auth-client';
import { API_URL } from './config';

/**
 * Study sessions (architecture §3.7): the server sends a VIEW of the current step and the app sends
 * back the ACTION the learner took. All state lives on the server, so a session can be closed at
 * any point and picked up again, also on another phone.
 */

export interface Suggestion {
  journey: JourneyId;
  chapter: number;
  chapterTitle: string;
  topic?: string;
  title: string;
  reason: string;
}

export interface Progress {
  daysStudied: number;
  sessionsFinished: number;
  topics: { started: number; gotIt: number };
  cards: { reviewed: number; known: number; due: number };
  ownCards: number;
  hooks: number;
}

export interface StudyHome {
  offeringId: string;
  ready: boolean;
  resume: {
    id: string;
    journey: JourneyId;
    title: string;
    chapter: number;
    status: SessionStatus;
    updatedAt: number;
  } | null;
  suggestions: Suggestion[];
  progress: Progress;
}

export interface Artefact {
  id: string;
  kind: ArtefactKind;
  chapter: number;
  topic: string;
  content: Record<string, string>;
  createdAt: number;
}

export interface Handoff {
  title: string;
  text: string;
  helplines: string[];
  told: string;
}

const q = (enrolmentId: string | undefined) =>
  enrolmentId ? `?enrolmentId=${encodeURIComponent(enrolmentId)}` : '';

export function useStudyHome(enrolmentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['study', 'home', enrolmentId],
    queryFn: () => api<StudyHome>(`/sessions/home${q(enrolmentId)}`),
    enabled,
    staleTime: 10_000,
  });
}

export function useTopicLevels(enrolmentId: string | undefined) {
  return useQuery({
    queryKey: ['study', 'progress', enrolmentId],
    queryFn: () =>
      api<{ summary: Progress; topics: { chapter: number; topic: string; level: number }[] }>(
        `/learner/progress${q(enrolmentId)}`,
      ),
    // Students only (the caller passes no enrolment for anyone else).
    enabled: !!enrolmentId,
    staleTime: 10_000,
  });
}

export function useInterests() {
  return useQuery({
    queryKey: ['learner', 'interests'],
    queryFn: () => api<{ interests: string[]; options: string[] }>('/learner/interests'),
  });
}

export function useArtefacts(enrolmentId: string | undefined) {
  return useQuery({
    queryKey: ['learner', 'artefacts', enrolmentId],
    queryFn: () => api<{ artefacts: Artefact[] }>(`/learner/artefacts${q(enrolmentId)}`),
  });
}

/** Starts a session, or returns the open one for the same topic / chapter. */
export const startSession = (body: {
  journey: JourneyId;
  enrolmentId?: string;
  chapter: number;
  topic?: string;
}) => api<{ view: SessionView; resumed: boolean }>('/sessions', { method: 'POST', body });

export const getSession = (id: string) => api<{ view: SessionView }>(`/sessions/${id}`);

export interface ActBody {
  action: string;
  seq: number;
  value?: string | number;
  fields?: Record<string, string>;
}

/**
 * One learner action. The coach's text arrives as `delta` events while it is written; the last
 * event is the new `view` (or an `error` that leaves the session where it was).
 */
export async function actStream(
  sessionId: string,
  body: ActBody,
  onEvent: (e: SessionEvent) => void,
): Promise<void> {
  const fail = (code: string, message: string) => onEvent({ type: 'error', code, message });
  const cookie = await authClient.getCookie();
  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(`${API_URL}/api/sessions/${sessionId}/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ ...body, stream: true }),
      credentials: 'omit',
    });
  } catch {
    return fail('network', "Can't reach AI Coach. Nothing was lost: try again when you're online.");
  }
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not JSON */
    }
    return fail(String(res.status), message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)) as SessionEvent);
      }
    }
  } catch {
    // The connection dropped mid-reply. The server finishes the step; reloading shows where it is.
    fail('network', 'The connection dropped. Reloading your session…');
  }
}
