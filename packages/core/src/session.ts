import { z } from 'zod';
import type { AssetSource } from './assets';

/**
 * Study sessions (architecture §3.7, §7 Phase 4): what the API and the apps share. A session is one
 * 7–12 minute unit of a journey; the server sends a VIEW of the current step (what to show, which
 * buttons, which text boxes) and the app sends back the ACTION the learner took.
 */

export const JOURNEYS = ['explain', 'memorise'] as const;
export type JourneyId = (typeof JOURNEYS)[number];
export const JOURNEY_LABELS: Record<JourneyId, string> = {
  explain: 'Understand',
  memorise: 'Memorise',
};

/** active/paused can be resumed; done, stopped (ended early by the learner), handoff, expired can't. */
export const SESSION_STATUSES = [
  'active',
  'paused',
  'done',
  'stopped',
  'handoff',
  'expired',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const isOpenSession = (s: SessionStatus) => s === 'active' || s === 'paused';

// ---------------------------------------------------------------- the view

export interface ViewCitation {
  n: number;
  bookTitle: string;
  page: number;
  supported: boolean;
}

export type ViewBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; muted?: boolean }
  /** Markdown; [S#] markers become page badges from `sources`. */
  | { type: 'markdown'; text: string; sources?: AssetSource[] }
  | { type: 'badges'; items: { label: string; strong?: boolean }[] }
  | {
      type: 'callout';
      tone: 'info' | 'success' | 'warning' | 'safety';
      title?: string;
      text: string;
    }
  /** One turn of the conversation with the coach at this step. */
  | {
      type: 'chat';
      role: 'you' | 'coach';
      text: string;
      citations?: ViewCitation[];
      /** Honest warnings: "not in your textbook", "check this sum", … */
      flags?: string[];
    }
  /** A recall card; `back` is absent until the learner asks to see it. */
  | { type: 'card'; label: string; front: string; back?: string }
  | { type: 'list'; items: string[] }
  /** A running clock for a timed write-out. */
  | { type: 'timer'; elapsedMs: number; targetMinutes: number };

export interface ViewAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'link';
  /** Sent back as `value` with the action (e.g. which option, which rating). */
  value?: string | number;
}

export interface ViewForm {
  id: string;
  title?: string;
  fields: {
    name: string;
    label: string;
    placeholder?: string;
    multiline?: boolean;
    value?: string;
  }[];
  /** One text box can have several buttons ("Ask", "I disagree"). */
  submits: { action: string; label: string; style?: 'primary' | 'secondary' }[];
}

/** What a journey shows at a step (built by pure code in packages/journeys). */
export interface JourneyView {
  title: string;
  subtitle: string;
  progress: { step: number; of: number; label: string };
  blocks: ViewBlock[];
  actions: ViewAction[];
  forms: ViewForm[];
}

export interface SessionView extends JourneyView {
  sessionId: string;
  journey: JourneyId;
  status: SessionStatus;
  node: string;
  seq: number;
  /** Total charged for AI replies in this session so far (micro-INR). */
  billedMicro: number;
  startedAt: number;
}

/** Events of POST /api/sessions/:id/act (Server-Sent Events; with stream:false the last view as JSON). */
export type SessionEvent =
  | { type: 'delta'; text: string }
  | { type: 'view'; view: SessionView; billedMicro: number }
  | { type: 'error'; code: string; message: string; view?: SessionView };

// ---------------------------------------------------------------- requests

export const startSessionSchema = z.object({
  journey: z.enum(JOURNEYS),
  enrolmentId: z.string().min(1).optional(),
  /** Admin only (testing): the subject to study. */
  offeringId: z.string().min(1).optional(),
  chapter: z.number().int().min(1).max(60),
  /** Explanation sessions: the topic (as named in the chapter). */
  topic: z.string().trim().min(1).max(200).optional(),
});

export const sessionActSchema = z.object({
  action: z.string().trim().min(1).max(40),
  /** The step number the app is looking at (SessionView.seq). */
  seq: z.number().int().min(0),
  value: z.union([z.string().max(60), z.number()]).optional(),
  fields: z.record(z.string().max(40), z.string().max(2000)).optional(),
  stream: z.boolean().default(true),
});
export type SessionAct = z.infer<typeof sessionActSchema>;

// ---------------------------------------------------------------- mastery (decision 9.6-9)

export const MASTERY_LABELS = [
  'Not started',
  'Seen',
  'Got it with help',
  'Got it',
  'Can teach it',
] as const;
export type MasteryLevel = 0 | 1 | 2 | 3 | 4;

// ---------------------------------------------------------------- spaced recall (decision 9.6-7)

export const RECALL_RATINGS = ['got', 'almost', 'forgot'] as const;
export type RecallRating = (typeof RECALL_RATINGS)[number];
/** Days until the next review, by box (1–5). */
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 16, 35] as const;
export const MAX_BOX = 5;
/** A card counts as known from this box on (it has survived at least a 3-day gap). */
export const KNOWN_BOX = 3;

const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
/** Start of the Indian calendar day that `at` falls in (ms since epoch). */
export const dayStartIst = (at: number) =>
  Math.floor((at + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;

/**
 * Leitner step. `box` 0 = never reviewed. Cards fall due at the start of a day, so studying a
 * little earlier or later the next day doesn't matter. `repeat` = the card already came up in this
 * session (it was forgotten and returned): it can't move up twice in one sitting.
 */
export function nextReview(box: number, rating: RecallRating, now: number, repeat = false) {
  const current = Math.min(MAX_BOX, Math.max(1, Math.round(box) || 1));
  const next =
    rating === 'forgot' || repeat
      ? 1
      : rating === 'almost'
        ? current
        : Math.min(MAX_BOX, current + 1);
  return { box: next, dueAt: dayStartIst(now) + BOX_INTERVAL_DAYS[next]! * DAY_MS };
}

// ---------------------------------------------------------------- learner's own things

export const ARTEFACT_KINDS = ['card', 'mnemonic'] as const;
export type ArtefactKind = (typeof ARTEFACT_KINDS)[number];
export type ArtefactContent = { front: string; back: string } | { text: string; for: string };

const line = (max: number) => z.string().trim().min(1).max(max);
export const ownCardSchema = z.object({
  enrolmentId: z.string().min(1).optional(),
  chapter: z.number().int().min(1).max(60),
  topic: z.string().trim().max(200).optional(),
  front: line(300),
  back: line(800),
});
export const editArtefactSchema = z.object({
  front: line(300).optional(),
  back: line(800).optional(),
  text: line(400).optional(),
});

/** Declared interests (spec 5.5.11): the learner chooses; nothing is inferred from behaviour. */
export const INTEREST_OPTIONS = [
  'Cricket',
  'Football',
  'Kabaddi',
  'Music',
  'Movies',
  'Gaming',
  'Cooking',
  'Drawing',
  'Dance',
  'Coding',
  'Business',
  'Bikes and cars',
  'Travel',
  'Photography',
  'Fashion',
  'Reading',
  'Fitness',
  'Anime',
] as const;
export const MAX_INTERESTS = 5;
export const interestsSchema = z.object({
  interests: z
    .array(
      z
        .string()
        .trim()
        .min(2)
        .max(30)
        .regex(/^[\p{L}\p{N} &'-]+$/u, 'Use letters and numbers only'),
    )
    .max(MAX_INTERESTS, `Choose up to ${MAX_INTERESTS}`),
});

/** Small non-cryptographic hash (FNV-1a) for stable card keys. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
/** Key of a platform card inside a cards asset: survives re-approval while its front is unchanged. */
export const cardKey = (slotKey: string, front: string) =>
  `${slotKey}#${shortHash(front.trim().toLowerCase())}`;
export const ownCardKey = (artefactId: string) => `own:${artefactId}`;
