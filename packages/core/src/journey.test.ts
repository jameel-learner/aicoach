import { describe, expect, it } from 'vitest';
import {
  edges,
  findEdge,
  InvalidTransition,
  listens,
  startOf,
  step,
  transitions,
  validateGraph,
  type Graph,
} from './journey';

type N = 'a' | 'b' | 'end' | 'stop';
type E = { type: 'go'; n: number } | { type: 'back' } | { type: 'halt' };
interface S {
  total: number;
}
const e = edges<S, E, N>();
const graph: Graph<S, E, N> = {
  id: 'toy',
  version: 1,
  start: 'a',
  nodes: { a: {}, b: {}, end: { terminal: true }, stop: { terminal: true } },
  edges: [
    e({
      id: 'a.go.big',
      from: 'a',
      on: 'go',
      to: 'end',
      guard: (_s, ev) => ev.n >= 10,
      apply: (s, ev) => ({ total: s.total + ev.n }),
    }),
    e({ id: 'a.go', from: 'a', on: 'go', to: 'b', apply: (s, ev) => ({ total: s.total + ev.n }) }),
    e({ id: 'b.back', from: 'b', on: 'back', to: 'a' }),
    e({ id: 'any.halt', from: '*', on: 'halt', to: 'stop' }),
  ],
};

describe('journey graph engine', () => {
  it('takes the first edge whose guard passes, applies it and counts the step', () => {
    const start = startOf(graph, { total: 0 });
    const one = step(graph, start, { type: 'go', n: 3 });
    expect(one).toMatchObject({ edge: 'a.go', from: 'a' });
    expect(one.checkpoint).toEqual({ node: 'b', state: { total: 3 }, seq: 1 });
    const two = step(graph, step(graph, one.checkpoint, { type: 'back' }).checkpoint, {
      type: 'go',
      n: 10,
    });
    expect(two.edge).toBe('a.go.big');
    expect(two.checkpoint).toEqual({ node: 'end', state: { total: 13 }, seq: 3 });
    // The checkpoint it started from is untouched (a failed step can simply be retried).
    expect(start).toEqual({ node: 'a', state: { total: 0 }, seq: 0 });
  });

  it('refuses an event that is not possible at the node, and anything after the end', () => {
    const start = startOf(graph, { total: 0 });
    expect(() => step(graph, start, { type: 'back' })).toThrow(InvalidTransition);
    const ended = step(graph, start, { type: 'halt' }).checkpoint;
    expect(ended.node).toBe('stop');
    expect(findEdge(graph, ended, { type: 'halt' })).toBeNull();
    expect(listens(graph, 'a', 'go')).toBe(true);
    expect(listens(graph, 'b', 'go')).toBe(false);
    expect(listens(graph, 'end', 'halt')).toBe(false);
  });

  it('lists every (edge, node) pair, expanding the wildcard to the non-terminal nodes', () => {
    expect(transitions(graph).map((t) => t.key)).toEqual([
      'a.go.big@a',
      'a.go@a',
      'b.back@b',
      'any.halt@a',
      'any.halt@b',
    ]);
  });

  it('finds structural problems', () => {
    expect(validateGraph(graph)).toEqual([]);
    const broken: Graph<S, E, N> = {
      ...graph,
      nodes: { a: {}, b: {}, end: { terminal: true }, stop: {} },
      edges: [
        e({ id: 'x', from: 'a', on: 'go', to: 'b' }),
        e({ id: 'x', from: 'b', on: 'back', to: 'a' }),
        e({ id: 'y', from: 'end', on: 'back', to: 'a' }),
      ],
    };
    expect(validateGraph(broken)).toEqual([
      'edge id "x" is used twice',
      'edge "y" leaves terminal node "end"',
      'node "a" can\'t reach an end',
      'node "b" can\'t reach an end',
      'node "end" can\'t be reached from the start',
      'node "stop" can\'t be reached from the start',
      'node "stop" has no way out',
      'node "stop" can\'t reach an end',
    ]);
  });
});
