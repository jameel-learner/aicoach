import {
  conceptGraphSchema,
  findCycle,
  graphNodes,
  slotKey,
  type AssetCheck,
  type ConceptGraphDraft,
  type ConceptNode,
  type ExamStrategy,
  type StoredNote,
} from '@aicoach/core';
import { learningAssets, type Db } from '@aicoach/db';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Env } from '../env';
import { saveVersion, strategyOf, writeCritiqueFix, type SlotRef } from './shared';

/**
 * Concept graph (architecture §7 Phase 3: prerequisites for mastery gating later). One per subject
 * (slot `graph:0:<subject>:0`). Nodes are the approved strategy's topics with stable ids; the model
 * proposes "learn A before B" edges with a reason, the critic checks them, and code keeps only
 * edges between known topics and flags cycles.
 */

export const GRAPH_PROMPT_VERSION = 'graph@1';

export function planGraphSlot(s: ExamStrategy): SlotRef {
  return {
    key: slotKey('graph', 0, `${s.board} ${s.className} ${s.subject}`, 0),
    chapter: 0,
    topic: `${s.board} ${s.className} ${s.subject}`,
    marks: 0,
  };
}

export interface GraphContext {
  subject: string;
  chapters: { no: number; title: string }[];
  nodes: (ConceptNode & { summary: string | null })[];
}

const JSON_ONLY = 'Reply with ONE JSON object only (no Markdown fences, no commentary).';

const contextText = (c: GraphContext) =>
  [
    `Subject: ${c.subject}`,
    `Topics by chapter (id, topic${c.nodes.some((n) => n.summary) ? ', what the study note says' : ''}):`,
    ...c.chapters.map(
      (ch) =>
        `Chapter ${ch.no}: ${ch.title}\n${c.nodes
          .filter((n) => n.chapter === ch.no)
          .map((n) => `- ${n.id} ${n.topic}${n.summary ? `: ${n.summary}` : ''}`)
          .join('\n')}`,
    ),
  ].join('\n\n');

export const GRAPH_WRITER_PROMPT = {
  system: [
    'You map which topics a student must understand before others, for one school subject. Students use it to learn in a sensible order.',
    JSON_ONLY,
    'Shape: {"edges":[{"from":"c1.2","to":"c3.1","why":"..."}]}  ("from" must be understood before "to").',
    'Rules:',
    '- Use ONLY the topic ids listed. An edge means: without understanding "from", a student cannot really follow "to" (not merely "related" or "comes earlier in the book").',
    '- Include prerequisites inside a chapter and across chapters. Keep only direct prerequisites (if A → B and B → C, do not add A → C).',
    '- No cycles. "why" in one short sentence a student understands.',
    '- Most topics have 0–3 prerequisites.',
  ].join('\n'),
  user: (c: GraphContext) => contextText(c),
} as const;

export const GRAPH_CRITIC_PROMPT = {
  system: [
    'You are a senior teacher reviewing a prerequisite map of a subject. Find real problems; do not rewrite it.',
    JSON_ONLY,
    'Shape: {"scores":{"accuracy":1-5,"grounded":1-5,"marksFit":1-5,"presentation":1-5,"clarity":1-5},"issues":[{"severity":"major|minor","where":"edge from → to","problem":"...","fix":"..."}],"verdict":"pass|fix"}',
    '- accuracy: each edge is a genuine prerequisite; a wrong direction or a mere association is a major issue.',
    '- grounded: only listed topic ids are used.',
    '- marksFit: important prerequisites are not missing (a missing obvious one is a major issue); no indirect (transitive) edges.',
    '- presentation: no cycles; most topics have 0–3 prerequisites.',
    '- clarity: each "why" is short and clear to a student.',
    'verdict "fix" when there is any major issue or any score below 4; otherwise "pass".',
  ].join('\n'),
  user: (c: GraphContext, g: string) => `${contextText(c)}\n\nThe prerequisite map (JSON):\n${g}`,
} as const;

export const GRAPH_FIXER_PROMPT = {
  system: [
    GRAPH_WRITER_PROMPT.system,
    'You are given a draft and a review. Return the corrected map: fix every major issue and the minor ones that are right; keep what is already correct.',
  ].join('\n'),
  user: (c: GraphContext, g: string, issues: string) =>
    `${contextText(c)}\n\nDraft (JSON):\n${g}\n\nReview:\n${issues}`,
} as const;

/** Keeps edges between known topics (no self-loops, no repeats); reports what was dropped. */
export function cleanEdges(draft: ConceptGraphDraft, nodes: ConceptNode[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const kept: ConceptGraphDraft['edges'] = [];
  let dropped = 0;
  for (const e of draft.edges) {
    const from = e.from.trim();
    const to = e.to.trim();
    const k = `${from}>${to}`;
    if (!ids.has(from) || !ids.has(to) || from === to || seen.has(k)) {
      dropped++;
      continue;
    }
    seen.add(k);
    kept.push({ from, to, why: e.why });
  }
  return { edges: kept, dropped };
}

export function graphChecks(
  nodes: ConceptNode[],
  edges: ConceptGraphDraft['edges'],
  dropped: number,
): AssetCheck[] {
  const cycle = findCycle(
    nodes.map((n) => n.id),
    edges,
  );
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const incoming = new Map<string, number>();
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const heavy = [...incoming.values()].filter((n) => n > 4).length;
  const label = (id: string) => nodes.find((n) => n.id === id)?.topic ?? id;
  return [
    {
      name: 'Only known topics',
      ok: dropped === 0,
      detail: dropped
        ? `dropped ${dropped} edge(s) to unknown topics or repeated`
        : 'all edges valid',
    },
    {
      name: 'No cycles',
      ok: !cycle,
      detail: cycle ? cycle.map(label).join(' → ') : `${edges.length} edges, no cycle`,
    },
    {
      name: 'Topics connected',
      ok: linked.size >= nodes.length * 0.6,
      detail: `${linked.size} of ${nodes.length} topics have a prerequisite link`,
    },
    {
      name: 'Prerequisites per topic',
      ok: heavy === 0,
      detail: heavy ? `${heavy} topics with more than 4` : 'at most 4 per topic',
    },
  ];
}

async function graphContext(db: Db, offeringId: string, s: ExamStrategy): Promise<GraphContext> {
  const nodes = graphNodes(s);
  // The 1-mark (or lowest) note's summary per topic helps the model place it.
  const notes = await db
    .select({
      chapter: learningAssets.chapter,
      topic: learningAssets.topic,
      marks: learningAssets.marks,
      content: learningAssets.content,
    })
    .from(learningAssets)
    .where(
      and(
        eq(learningAssets.offeringId, offeringId),
        eq(learningAssets.kind, 'note'),
        ne(learningAssets.status, 'rejected'),
        ne(learningAssets.status, 'superseded'),
      ),
    )
    .orderBy(learningAssets.marks, desc(learningAssets.version));
  const summary = (n: ConceptNode) => {
    const r = notes.find((x) => x.chapter === n.chapter && x.topic === n.topic);
    const t = (r?.content as StoredNote | undefined)?.summary;
    return t ? t.replace(/\[S\d+\]/g, '').slice(0, 160) : null;
  };
  return {
    subject: `${s.board} ${s.className} ${s.subject}`,
    chapters: s.chapters.map((c) => ({ no: c.no, title: c.title })),
    nodes: nodes.map((n) => ({ ...n, summary: summary(n) })),
  };
}

const PROMPTS = {
  writer: GRAPH_WRITER_PROMPT,
  critic: GRAPH_CRITIC_PROMPT,
  fixer: GRAPH_FIXER_PROMPT,
};

async function produce(
  env: Env,
  db: Db,
  o: {
    run: { id: string | null; userId: string; offeringId: string; strategyId: string };
    s: ExamStrategy;
    rewrite?: { comment: string; asset: typeof learningAssets.$inferSelect };
  },
) {
  const ctx = await graphContext(db, o.run.offeringId, o.s);
  const nodes = ctx.nodes.map(({ id, chapter, topic }) => ({ id, chapter, topic }));
  const out = await writeCritiqueFix(env, db, {
    schema: conceptGraphSchema,
    prompts: PROMPTS,
    ctx,
    userId: o.run.userId,
    maxTokens: 12000,
    rewrite: o.rewrite
      ? {
          from: { edges: (o.rewrite.asset.content as ConceptGraphDraft).edges },
          comment: o.rewrite.comment,
        }
      : undefined,
  });
  const { edges, dropped } = cleanEdges(out.value, nodes);
  const id = await saveVersion(db, {
    kind: 'graph',
    promptVersion: GRAPH_PROMPT_VERSION,
    run: { id: o.run.id, offeringId: o.run.offeringId, strategyId: o.run.strategyId },
    slot: planGraphSlot(o.s),
    content: { nodes, edges },
    critique: out.critique,
    fixed: out.fixed,
    checks: graphChecks(nodes, edges, dropped),
    sources: [],
    cost: out.cost,
    reject:
      o.rewrite && o.rewrite.asset.status === 'draft'
        ? { id: o.rewrite.asset.id, comment: o.rewrite.comment, by: o.run.userId }
        : undefined,
  });
  return { id, cost: out.cost };
}

export async function generateGraph(
  env: Env,
  db: Db,
  run: { id: string; userId: string; offeringId: string; strategyId: string },
  s: ExamStrategy,
) {
  return (await produce(env, db, { run, s })).cost;
}

export async function rewriteGraph(
  env: Env,
  db: Db,
  asset: typeof learningAssets.$inferSelect,
  comment: string,
  userId: string,
) {
  const s = await strategyOf(db, asset.strategyId);
  return (
    await produce(env, db, {
      run: { id: null, userId, offeringId: asset.offeringId, strategyId: asset.strategyId! },
      s,
      rewrite: { comment, asset },
    })
  ).id;
}
