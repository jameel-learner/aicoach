/**
 * Journey graph engine (architecture §3.7, §4.3). A journey is a typed state graph: nodes are the
 * steps a learner sees, edges are guarded transitions taken on an event. Everything here is pure
 * (no I/O, no clock, no model): the SessionAgent does the I/O first (safety check, model call) and
 * then feeds the RESULT in as an event, so the learner's path is always decided by code that can be
 * unit-tested and read.
 */

export interface JourneyEvent {
  type: string;
}

/** What is saved after every step: enough to resume on any device. */
export interface Checkpoint<S, N extends string = string> {
  node: N;
  state: S;
  /** Number of steps taken; a client sends it back so a repeated request isn't applied twice. */
  seq: number;
}

export interface Edge<S, E extends JourneyEvent, N extends string> {
  /** Stable name, e.g. "check.answered.correct" (used in tests, logs and session_events). */
  id: string;
  /** Nodes it leaves from; '*' = every non-terminal node. */
  from: readonly N[] | '*';
  on: E['type'];
  to: N;
  guard?: (state: S, event: E) => boolean;
  apply?: (state: S, event: E) => S;
}

export interface Graph<S, E extends JourneyEvent, N extends string> {
  id: string;
  /** Bump when nodes or edges change in a way a saved checkpoint can't follow. */
  version: number;
  start: N;
  nodes: Record<N, { terminal?: boolean }>;
  edges: Edge<S, E, N>[];
}

/** Typed edge builder: `guard` and `apply` see the event narrowed to its `on` type. */
export function edges<S, E extends JourneyEvent, N extends string>() {
  return <T extends E['type']>(def: {
    id: string;
    from: N | readonly N[] | '*';
    on: T;
    to: N;
    guard?: (state: S, event: Extract<E, { type: T }>) => boolean;
    apply?: (state: S, event: Extract<E, { type: T }>) => S;
  }): Edge<S, E, N> =>
    ({
      ...def,
      from: def.from === '*' ? '*' : typeof def.from === 'string' ? [def.from] : def.from,
    }) as Edge<S, E, N>;
}

export class InvalidTransition extends Error {
  constructor(
    readonly graph: string,
    readonly node: string,
    readonly event: string,
  ) {
    super(`${graph}: "${event}" is not possible at "${node}"`);
  }
}

const leaves = <S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
  e: Edge<S, E, N>,
  node: N,
) => !g.nodes[node].terminal && (e.from === '*' || e.from.includes(node));

/** The first edge that leaves the current node on this event and whose guard passes. */
export function findEdge<S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
  cp: Checkpoint<S, N>,
  event: E,
): Edge<S, E, N> | null {
  return (
    g.edges.find(
      (e) => e.on === event.type && leaves(g, e, cp.node) && (!e.guard || e.guard(cp.state, event)),
    ) ?? null
  );
}

/** True when some edge leaves this node on this event type (guards not evaluated). */
export function listens<S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
  node: N,
  type: E['type'],
): boolean {
  return g.edges.some((e) => e.on === type && leaves(g, e, node));
}

export interface StepResult<S, N extends string> {
  checkpoint: Checkpoint<S, N>;
  edge: string;
  from: N;
}

/** Takes one step. Throws InvalidTransition when the event isn't possible here. */
export function step<S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
  cp: Checkpoint<S, N>,
  event: E,
): StepResult<S, N> {
  const e = findEdge(g, cp, event);
  if (!e) throw new InvalidTransition(g.id, cp.node, event.type);
  return {
    checkpoint: {
      node: e.to,
      state: e.apply ? e.apply(cp.state, event) : cp.state,
      seq: cp.seq + 1,
    },
    edge: e.id,
    from: cp.node,
  };
}

export const startOf = <S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
  state: S,
): Checkpoint<S, N> => ({ node: g.start, state, seq: 0 });

/** Every (edge, from-node) pair: what "100% transition coverage" counts. */
export function transitions<S, E extends JourneyEvent, N extends string>(g: Graph<S, E, N>) {
  const all = Object.keys(g.nodes) as N[];
  return g.edges.flatMap((e) =>
    (e.from === '*' ? all.filter((n) => !g.nodes[n].terminal) : e.from).map((from) => ({
      key: `${e.id}@${from}`,
      id: e.id,
      from,
      on: e.on,
      to: e.to,
    })),
  );
}
export const transitionKey = (edge: string, from: string) => `${edge}@${from}`;

/** Structural problems of a graph (empty = sound). Run in tests for every journey. */
export function validateGraph<S, E extends JourneyEvent, N extends string>(
  g: Graph<S, E, N>,
): string[] {
  const problems: string[] = [];
  const names = Object.keys(g.nodes) as N[];
  const known = (n: string) => names.includes(n as N);
  if (!known(g.start)) problems.push(`start node "${g.start}" is not a node`);
  else if (g.nodes[g.start].terminal) problems.push('the start node is terminal');
  const ids = new Set<string>();
  for (const e of g.edges) {
    if (ids.has(e.id)) problems.push(`edge id "${e.id}" is used twice`);
    ids.add(e.id);
    if (!known(e.to)) problems.push(`edge "${e.id}" goes to unknown node "${e.to}"`);
    if (e.from !== '*')
      for (const f of e.from) {
        if (!known(f)) problems.push(`edge "${e.id}" leaves unknown node "${f}"`);
        else if (g.nodes[f].terminal) problems.push(`edge "${e.id}" leaves terminal node "${f}"`);
      }
  }
  const t = transitions(g);
  const reach = (starts: N[], next: (n: N) => N[]) => {
    const seen = new Set<N>(starts);
    const todo = [...starts];
    while (todo.length)
      for (const m of next(todo.pop()!))
        if (!seen.has(m)) {
          seen.add(m);
          todo.push(m);
        }
    return seen;
  };
  const forward = reach(known(g.start) ? [g.start] : [], (n) =>
    t.filter((x) => x.from === n).map((x) => x.to),
  );
  const terminals = names.filter((n) => g.nodes[n].terminal);
  if (!terminals.length) problems.push('there is no terminal node');
  const canFinish = reach(terminals, (n) => t.filter((x) => x.to === n).map((x) => x.from));
  for (const n of names) {
    if (!forward.has(n)) problems.push(`node "${n}" can't be reached from the start`);
    if (!g.nodes[n].terminal && !t.some((x) => x.from === n))
      problems.push(`node "${n}" has no way out`);
    if (!canFinish.has(n)) problems.push(`node "${n}" can't reach an end`);
  }
  return problems;
}
