import {
  RUBRIC,
  splitCitations,
  type AssetSource,
  type CardsDraft,
  type ConceptNode,
  type Critique,
  type QuestionSet,
  type StoredGraph,
  type StoredNote,
} from '@aicoach/core';
import ReactMarkdown from 'react-markdown';
import { Badge } from './ui';
import { rehypePlugins, remarkPlugins } from '../lib/markdown';

/**
 * How generated learning material is shown on the web (Admin → Learning material and the
 * Teacher review): notes, chapter cards + memory map, question sets, the concept graph.
 */

export type AssetKind = 'note' | 'cards' | 'questions' | 'graph';
export type AssetStatus = 'draft' | 'approved' | 'rejected' | 'superseded';
export const STATUS: Record<AssetStatus, { label: string; tone?: 'good' | 'warn' }> = {
  draft: { label: 'To review', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  rejected: { label: 'Rejected' },
  superseded: { label: 'Superseded' },
};
export const avg = (c: Critique | null) =>
  c ? Object.values(c.scores).reduce((a, b) => a + b, 0) / RUBRIC.length : null;
export interface Target {
  minWords: number;
  maxWords: number;
  shape: string;
}

/** The body of any asset, by kind. */
export function AssetBody({
  kind,
  content,
  sources,
  target,
}: {
  kind: AssetKind;
  content: unknown;
  sources: AssetSource[];
  target: Target;
}) {
  if (kind === 'cards') return <CardsBody c={content as CardsDraft} sources={sources} />;
  if (kind === 'questions') return <QuestionsBody set={content as QuestionSet} sources={sources} />;
  if (kind === 'graph') return <GraphBody g={content as StoredGraph} />;
  return <NoteBody n={content as StoredNote} sources={sources} target={target} />;
}

/** [S2] → "(p. 65)" from the note's sources. */
const withPages = (md: string, sources: AssetSource[]) =>
  splitCitations(md).replace(/\[S(\d+)\]/g, (_, n: string) => {
    const s = sources.find((x) => x.n === Number(n));
    return s ? ` *(p. ${s.page})*` : '';
  });

export function Md({ text, sources }: { text: string; sources: AssetSource[] }) {
  return (
    <div className="prose-answer text-sm leading-relaxed [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:bg-surface-muted [&_th]:px-2">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {withPages(text, sources)}
      </ReactMarkdown>
    </div>
  );
}

function NoteBody({
  n,
  sources,
  target,
}: {
  n: StoredNote;
  sources: AssetSource[];
  target: Target;
}) {
  const a = { sources, target };
  const ex = n.examAnswer;
  const legacy = !ex && n.workedExample ? n.workedExample : null;
  return (
    <>
      {ex && (
        <div className="mb-4 rounded-lg border-2 border-primary p-3">
          <h4 className="font-semibold">
            Write this in the exam
            <span className="font-normal text-muted">
              {' '}
              · {ex.minutes ?? '?'} min
              {ex.marksSplit ? ` · marks ${ex.marksSplit}` : ''}
            </span>
          </h4>
          <div className="mt-1 text-sm font-medium">
            <Md text={ex.question} sources={a.sources} />
          </div>
          <Md text={ex.answer} sources={a.sources} />
        </div>
      )}
      <h4 className="mb-1 font-semibold">
        {ex ? 'Understand it' : 'Note'}
        {ex && (
          <span className="font-normal text-muted">
            {' '}
            · read, don't memorise · guide {a.target.minWords}–{a.target.maxWords} words
          </span>
        )}
      </h4>
      <p className="mb-3 rounded-lg bg-surface-muted p-3 text-sm font-medium">
        {withPages(n.summary, a.sources).replace(/\*/g, '')}
      </p>
      {n.sections.map((s) => (
        <div key={s.heading} className="mb-3">
          <h4 className="font-semibold">{s.heading}</h4>
          <Md text={s.body} sources={a.sources} />
        </div>
      ))}
      {legacy && (
        <div className="mb-3 rounded-lg border border-border p-3">
          <h4 className="font-semibold">
            Worked example
            {legacy.marksSplit ? ` (marks: ${legacy.marksSplit})` : ''}
          </h4>
          <p className="text-xs text-muted">
            Older note shape (note@1): no exam answer sized to the time.
          </p>
          <Md text={legacy.question} sources={a.sources} />
          <Md text={legacy.solution} sources={a.sources} />
        </div>
      )}
      {n.keyTerms.length > 0 && (
        <p className="mb-2 text-sm">
          <strong>Key terms:</strong> {n.keyTerms.join(' · ')}
        </p>
      )}
      {n.examTips.length > 0 && (
        <ul className="mb-2 list-disc pl-5 text-sm">
          {n.examTips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        <strong>Why this matters:</strong> {n.whyThisMatters.exam} {n.whyThisMatters.realWorld}
      </p>
    </>
  );
}

const CARD_TYPE_LABEL: Record<string, string> = {
  definition: 'Definition',
  formula: 'Formula',
  format: 'Format',
  rule: 'Rule',
  difference: 'Difference',
  fact: 'Fact',
};

/** Memory map (centre + branches) and the quick cards, grouped by topic. */
function CardsBody({ c, sources }: { c: CardsDraft; sources: AssetSource[] }) {
  const page = (cite: string | null) => {
    const n = Number(/S(\d+)/i.exec(cite ?? '')?.[1]);
    const s = sources.find((x) => x.n === n);
    return s ? `p. ${s.page}` : null;
  };
  const topics = [...new Set(c.cards.map((x) => x.topic))];
  return (
    <>
      <h4 className="mb-2 font-semibold">Memory map</h4>
      <div className="mb-4 rounded-lg border-2 border-primary p-3">
        <p className="mb-3 text-center font-semibold">{c.map.center}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {c.map.branches.map((b) => (
            <div key={b.label} className="rounded-lg bg-surface-muted p-2 text-sm">
              <p className="font-semibold">{b.label}</p>
              <ul className="list-disc pl-5">
                {b.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <h4 className="mb-2 font-semibold">
        Quick cards <span className="font-normal text-muted">· {c.cards.length} · to memorise</span>
      </h4>
      {topics.map((t) => (
        <div key={t} className="mb-3">
          <p className="mb-1 text-sm font-semibold">{t}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {c.cards
              .filter((x) => x.topic === t)
              .map((x, k) => (
                <div key={k} className="rounded-lg border border-border p-2 text-sm">
                  <p className="text-xs text-muted">
                    {CARD_TYPE_LABEL[x.type] ?? x.type}
                    {page(x.cite) ? ` · ${page(x.cite)}` : ''}
                  </p>
                  <p className="font-medium">{x.front}</p>
                  <p className="mt-1 border-t border-border pt-1">{x.back}</p>
                </div>
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

const TYPOLOGY_LABEL: Record<string, string> = {
  mcq: 'MCQ',
  fill_blank: 'Fill in the blank',
  match: 'Match',
  very_short: 'Very short',
  expand: 'Expand',
  true_false: 'True / false',
  short_answer: 'Short answer',
  problem: 'Problem',
};

/** A question set: each question with its type, difficulty, model answer and marking points. */
function QuestionsBody({ set, sources }: { set: QuestionSet; sources: AssetSource[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {set.questions.map((q, i) => {
        const n = Number(/S(\d+)/i.exec(q.cite ?? '')?.[1]);
        const src = sources.find((x) => x.n === n);
        return (
          <li key={i} className="rounded-lg border border-border p-3">
            <div className="mb-1 flex flex-wrap gap-2 text-xs">
              <Badge>Q{i + 1}</Badge>
              <Badge>{TYPOLOGY_LABEL[q.typology] ?? q.typology}</Badge>
              <Badge tone={q.difficulty === 'hots' ? 'warn' : undefined}>{q.difficulty}</Badge>
              <span className="text-muted">
                {q.cognitive} · {q.topic}
                {src ? ` · p. ${src.page}` : ''}
              </span>
            </div>
            <div className="text-sm font-medium">
              <Md text={q.question} sources={sources} />
            </div>
            {q.options && (
              <ol className="mb-2 list-[lower-alpha] pl-6 text-sm">
                {q.options.map((o) => (
                  <li key={o}>{o.replace(/^\(?[a-d][).]\s*/i, '')}</li>
                ))}
              </ol>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-primary">
                Model answer and marking points{q.marksSplit ? ` (${q.marksSplit})` : ''}
              </summary>
              <div className="mt-2">
                <Md text={q.answer} sources={sources} />
              </div>
              {q.markingPoints.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {q.markingPoints.map((m, k) => (
                    <li key={k}>
                      {m.point} <span className="text-muted">({m.marks})</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** Concept graph: per chapter, each topic with what to learn first (and why). */
function GraphBody({ g }: { g: StoredGraph }) {
  const byId = new Map<string, ConceptNode>(g.nodes.map((n) => [n.id, n]));
  const chapters = [...new Set(g.nodes.map((n) => n.chapter))];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted">
        {g.edges.length} prerequisite links between {g.nodes.length} topics. "Learn first" means a
        student needs that topic to follow this one.
      </p>
      {chapters.map((ch) => (
        <div key={ch}>
          <p className="mb-1 font-semibold">Chapter {ch}</p>
          <ul className="flex flex-col gap-1">
            {g.nodes
              .filter((n) => n.chapter === ch)
              .map((n) => {
                const needs = g.edges.filter((e) => e.to === n.id);
                return (
                  <li key={n.id} className="rounded-lg border border-border p-2">
                    <span className="font-medium">{n.topic}</span>
                    {needs.length === 0 ? (
                      <span className="text-muted"> · no prerequisite</span>
                    ) : (
                      <ul className="mt-1 list-disc pl-5">
                        {needs.map((e) => {
                          const f = byId.get(e.from);
                          return (
                            <li key={e.from}>
                              Learn first: {f?.topic ?? e.from}
                              {f && f.chapter !== ch ? ` (chapter ${f.chapter})` : ''}{' '}
                              <span className="text-muted">· {e.why}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}
