import type { AssetSource, CardsDraft, QuestionSet, StoredNote, SubjectMap } from '@aicoach/core';
import { useQuery } from '@tanstack/react-query';
import { Directory, File, Paths } from 'expo-file-system';
import { api, ApiRequestError } from './api';

/**
 * Approved learning material for the learner's subject (architecture §7 Phase 3): the chapter
 * index and each chapter's notes, cards, question sets and prerequisites. Every successful load is
 * saved on the phone, so a chapter opened once can be read again offline.
 */

export interface MaterialIndex {
  offeringId: string;
  ready: boolean;
  subject?: string;
  stamp: number;
  chapters: (SubjectMap['chapters'][number] & {
    notes: number;
    cards: boolean;
    questionSets: number[];
  })[];
  /** Set when this came from the phone because the network was not reachable. */
  offline?: boolean;
}

export interface Asset<T> {
  id: string;
  topic: string;
  marks: number;
  version: number;
  content: T;
  sources: AssetSource[];
}

export interface ChapterMaterial {
  offeringId: string;
  stamp: number;
  chapter: {
    no: number;
    title: string;
    marks: number;
    topics: { name: string; examPapers: number; marks: number[] }[];
  };
  notes: Asset<StoredNote>[];
  cards: Asset<CardsDraft> | null;
  questions: Asset<QuestionSet>[];
  prerequisites: Record<string, { topic: string; chapter: number; why: string }[]>;
  offline?: boolean;
}

const folder = () => new Directory(Paths.document, 'material');
const fileFor = (key: string) => new File(folder(), `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

async function readSaved<T>(key: string): Promise<T | null> {
  try {
    const f = fileFor(key);
    if (!f.exists) return null;
    return JSON.parse(await f.text()) as T;
  } catch {
    return null;
  }
}

async function save(key: string, value: unknown) {
  try {
    const d = folder();
    if (!d.exists) d.create({ intermediates: true });
    const f = fileFor(key);
    if (!f.exists) f.create();
    await f.write(JSON.stringify(value));
  } catch {
    // Saving for offline is best effort; reading online still works.
  }
}

/** Load from the API and save a copy; without a network, fall back to the saved copy. */
async function withOfflineCopy<T extends object>(key: string, load: () => Promise<T>) {
  try {
    const v = await load();
    void save(key, v);
    return v;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 0) {
      const saved = await readSaved<T>(key);
      if (saved) return { ...saved, offline: true };
    }
    throw err;
  }
}

const q = (enrolmentId: string | undefined) =>
  enrolmentId ? `?enrolmentId=${encodeURIComponent(enrolmentId)}` : '';

export function useMaterialIndex(enrolmentId: string | undefined) {
  return useQuery({
    queryKey: ['material', 'index', enrolmentId],
    queryFn: () =>
      withOfflineCopy(`index-${enrolmentId ?? 'default'}`, () =>
        api<MaterialIndex>(`/material${q(enrolmentId)}`),
      ),
    networkMode: 'always',
    staleTime: 60_000,
  });
}

export function useChapter(enrolmentId: string | undefined, no: number) {
  return useQuery({
    queryKey: ['material', 'chapter', enrolmentId, no],
    queryFn: () =>
      withOfflineCopy(`chapter-${enrolmentId ?? 'default'}-${no}`, () =>
        api<ChapterMaterial>(`/material/chapters/${no}${q(enrolmentId)}`),
      ),
    networkMode: 'always',
    staleTime: 60_000,
    enabled: Number.isInteger(no) && no > 0,
  });
}
