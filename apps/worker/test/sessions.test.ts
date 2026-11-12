import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testVectors } from '../src/content/store';
import type { Env } from '../src/env';
import { ConsoleNotifier, createNotifier, memoryOutbox } from '../src/lib/notifier';
import { handoff } from '../src/safety/handoff';
import { createDb } from '@aicoach/db';
import { clearRegistryCache } from '../src/llm/registry';
import { mcqCorrectIndex } from '../src/sessions/plan';
import type { StoredSession } from '../src/sessions/agent';
import { call, json, signIn, createSignedInUser, type Jar } from './helpers';
import { installOpenRouterMock, type MockState } from './openrouter-mock';
import { balanceOf, setupStudy, sse, STUDY_TABLES, type Study } from './study-setup';

/**
 * Phase 4: study sessions end to end (SessionAgent Durable Object, journeys, safety, records).
 * Exit criteria covered here: kill-and-resume on another device; distress routes to the handoff
 * without a model call. (Transition coverage: packages/journeys; red-team set: safety-rules.test.)
 */

let or: MockState;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks_fts'),
    ...STUDY_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  ]);
  testVectors.clear();
  memoryOutbox.length = 0;
  or = installOpenRouterMock();
  clearRegistryCache();
  // One reply per kind of session call, recognised by its system prompt.
  or.replyFor = (body) => {
    const system = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.at(-1)?.content ?? '');
    if (system.startsWith('You are AI Coach, tutoring'))
      return 'Goodwill is the value of the reputation of a firm [S1]. Two years of ₹30,000 profit: 30,000 × 2 = 50,000.';
    if (system.startsWith('You mark a student')) {
      const mine = user.split("Student's answer:")[1] ?? '';
      return mine.includes('reputation')
        ? '{"verdict":"correct","feedback":"Yes: the value of reputation."}'
        : '{"verdict":"partial","feedback":"Think about what a buyer pays extra for."}';
    }
    if (system.startsWith('You give ONE hint')) return 'Think about why a known shop sells more.';
    if (system.includes('teach-it-back'))
      return '{"covered":["value of reputation"],"missing":[],"good":true,"feedback":"Clear and correct."}';
    if (system.startsWith('You help a student make a memory hook'))
      return '{"ideas":["GOOD name = GOODwill","A cricketer with a big name sells more bats"]}';
    return undefined;
  };
});
afterEach(() => vi.restoreAllMocks());

const start = (jar: Jar, body: Record<string, unknown>) =>
  call('POST', '/api/sessions', { jar, body });
/** One action without streaming: returns the event (view or error) and the HTTP status. */
async function act(jar: Jar, view: { sessionId: string; seq: number }, action: string, more = {}) {
  const res = await call('POST', `/api/sessions/${view.sessionId}/act`, {
    jar,
    body: { action, seq: view.seq, stream: false, ...more },
  });
  return { status: res.status, ...(await json(res)) };
}
const text = (v: unknown) => JSON.stringify(v);
const stubOf = (id: string) => {
  const ns = (env as unknown as Env).SESSION_AGENT!;
  return ns.get(ns.idFromName(id));
};
const row = (sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<Record<string, any>>();

describe('explanation session', () => {
  it('runs a whole unit: answer first, a cited reply, hint, retry, teach-back, own card; charges and records it', async () => {
    const t: Study = await setupStudy(or);
    const before = await balanceOf(t.studentW.id);
    const calls = () => or.requests.length;

    const started = await start(t.student.jar, {
      journey: 'explain',
      chapter: 1,
      topic: 'goodwill',
    });
    expect(started.status).toBe(201);
    let { view } = await json(started);
    expect(view).toMatchObject({ node: 'brief', seq: 0, status: 'active', title: 'Goodwill' });
    expect(text(view)).toContain('In 4 of 8 board papers');
    expect(text(view)).toContain('It helps to know first: Partnership deed');

    // Free steps: no model call.
    const n0 = calls();
    view = (await act(t.student.jar, view, 'start')).view;
    expect(view.node).toBe('answer');
    expect(text(view)).toContain('Goodwill in one line');
    view = (await act(t.student.jar, view, 'working')).view;
    expect(text(view)).toContain('Worked answer · 6 marks (1+2+2+1=6)');
    expect(calls()).toBe(n0);

    // A question: streamed, grounded in the book, charged, and the wrong sum is flagged.
    const res = await call('POST', `/api/sessions/${view.sessionId}/act`, {
      jar: t.student.jar,
      body: { action: 'ask', seq: view.seq, fields: { text: 'Why does goodwill matter?' } },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sse(res);
    const streamed = events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('');
    expect(streamed).toContain('Goodwill is the value of the reputation');
    const done = events.at(-1);
    expect(done.type).toBe('view');
    const perCall = done.billedMicro;
    expect(perCall).toBeGreaterThan(0);
    view = done.view;
    const reply = view.blocks.findLast((b: any) => b.type === 'chat' && b.role === 'coach');
    expect(reply.citations[0]).toMatchObject({ bookTitle: 'NCERT Accountancy Part I', page: 2 });
    expect(reply.flags.join(' ')).toContain('Check this sum');
    expect(reply.flags.join(' ')).toContain('60,000');
    expect(or.systems.at(-1)).toContain(
      'tutoring a KSEAB 2nd PUC Accountancy student on "Goodwill"',
    );

    // Check question from the approved question bank; hint, a wrong try, then right.
    view = (await act(t.student.jar, view, 'ready')).view;
    expect(view.node).toBe('check');
    expect(text(view)).toContain('Define goodwill.');
    view = (await act(t.student.jar, view, 'hint')).view;
    expect(text(view)).toContain('Think about why a known shop sells more.');
    view = (await act(t.student.jar, view, 'answer', { fields: { text: 'It is a kind of loan' } }))
      .view;
    expect(view.node).toBe('check');
    expect(text(view)).toContain('Trying again costs nothing');
    view = (
      await act(t.student.jar, view, 'answer', {
        fields: { text: 'The value of the reputation of the firm' },
      })
    ).view;
    expect(view.node).toBe('feedback');
    expect(text(view)).toContain("That's right");

    view = (await act(t.student.jar, view, 'teach')).view;
    view = (
      await act(t.student.jar, view, 'explain', {
        fields: { text: 'Goodwill is what a good name is worth' },
      })
    ).view;
    expect(text(view)).toContain('You covered:');
    view = (await act(t.student.jar, view, 'card')).view;
    const end = await act(t.student.jar, view, 'save_card', {
      fields: { front: 'Goodwill?', back: 'What a good name is worth' },
    });
    view = end.view;
    expect(view).toMatchObject({ node: 'micro_win', status: 'done', seq: 11 });
    expect(text(view)).toContain('right, with 1 hint');
    expect(text(view)).toContain('Where you are on this topic: Got it.');
    expect(view.actions).toEqual([]);

    // Five model calls (question, hint, two markings, teach-back), each charged once, exactly.
    expect(view.billedMicro).toBe(5 * perCall);
    expect(before - (await balanceOf(t.studentW.id))).toBe(5 * perCall);

    // Records: the session, one event per step, mastery, the learner's card.
    const s = await row('SELECT * FROM study_sessions WHERE id = ?', view.sessionId);
    expect(s).toMatchObject({ status: 'done', node: 'micro_win', seq: 11, topic: 'Goodwill' });
    expect(JSON.parse(s!.outcome)).toMatchObject({ level: 3, check: 'with_hints', card: true });
    expect(s!.billed_micro).toBe(5 * perCall);
    const ev = await row(
      'SELECT count(*) n, sum(billed_micro) b FROM session_events WHERE session_id = ?',
      view.sessionId,
    );
    expect(ev).toEqual({ n: 11, b: 5 * perCall });
    expect(
      await row('SELECT level, best, sessions FROM mastery WHERE user_id = ?', t.student.id),
    ).toEqual({ level: 3, best: 3, sessions: 1 });
    const locker = await json(await call('GET', '/api/learner/artefacts', { jar: t.student.jar }));
    expect(locker.artefacts).toMatchObject([
      { kind: 'card', chapter: 1, topic: 'Goodwill', content: { front: 'Goodwill?' } },
    ]);

    // A finished session accepts nothing more, and a repeated request changes nothing.
    const again = await act(t.student.jar, view, 'finish');
    expect(again).toMatchObject({
      status: 200,
      type: 'view',
      view: { seq: 11, node: 'micro_win' },
    });

    // Home: nothing to resume; the finished topic is no longer suggested; honest numbers.
    const home = await json(await call('GET', '/api/sessions/home', { jar: t.student.jar }));
    expect(home.resume).toBeNull();
    expect(home.suggestions.map((x: any) => `${x.journey}:${x.title}`)).toEqual([
      'memorise:Cards: Partnership basics',
      'explain:Partnership deed',
    ]);
    expect(home.progress).toMatchObject({
      daysStudied: 1,
      sessionsFinished: 1,
      topics: { started: 1, gotIt: 1 },
      ownCards: 1,
    });

    // Private: nobody else can read or drive the session, and teachers don't run sessions (9.6-10).
    const other = await createSignedInUser('student');
    expect((await call('GET', `/api/sessions/${view.sessionId}`, { jar: other.jar })).status).toBe(
      404,
    );
    expect((await act(other.jar, view, 'finish')).status).toBe(404);
    expect(
      (await call('GET', `/api/sessions/${view.sessionId}`, { jar: t.teacher.jar })).status,
    ).toBe(404);
    expect(
      (await start(t.teacher.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' })).status,
    ).toBe(403);
  });

  it('survives a failed call and a killed app: resumes at the same step on another device', async () => {
    const t = await setupStudy(or);
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    view = (await act(t.student.jar, view, 'ask', { fields: { text: 'What is goodwill?' } })).view;
    view = (await act(t.student.jar, view, 'deeper')).view;
    expect(view).toMatchObject({ node: 'depth', seq: 3 });
    const paid = await balanceOf(t.studentW.id);

    // The model fails mid-step: an error, the step is not taken, the hold is released.
    or.fail = { status: 500, message: 'upstream down' };
    const failed = await act(t.student.jar, view, 'ask', { fields: { text: 'And why?' } });
    expect(failed).toMatchObject({ status: 502, type: 'error', code: 'llm_error' });
    expect(failed.view).toMatchObject({ node: 'depth', seq: 3 });
    expect(await balanceOf(t.studentW.id)).toBe(paid);
    expect((await row('SELECT held_micro h FROM wallets WHERE id = ?', t.studentW.id))!.h).toBe(0);
    or.fail = false;

    // The app is killed and the Durable Object leaves memory.
    await evictDurableObject(stubOf(view.sessionId));

    // Another device (a new sign-in): the same step, with the conversation so far.
    const phone2 = await signIn(t.student.email);
    const resumed = await json(
      await call('GET', `/api/sessions/${view.sessionId}`, { jar: phone2 }),
    );
    expect(resumed.view).toMatchObject({ node: 'depth', seq: 3, status: 'active' });
    expect(text(resumed.view)).toContain('What is goodwill?');
    const home = await json(await call('GET', '/api/sessions/home', { jar: phone2 }));
    expect(home.resume).toMatchObject({
      id: view.sessionId,
      title: 'Goodwill',
      journey: 'explain',
    });

    // Starting the same topic again resumes it instead of opening a second session.
    const again = await start(phone2, { journey: 'explain', chapter: 1, topic: 'Goodwill' });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({
      resumed: true,
      view: { sessionId: view.sessionId, seq: 3 },
    });

    // The first device still shows step 3 and taps twice: applied once.
    const next = await act(phone2, resumed.view, 'ready');
    expect(next.view).toMatchObject({ node: 'check', seq: 4 });
    const stale = await act(t.student.jar, view, 'ready');
    expect(stale).toMatchObject({ type: 'view', view: { node: 'check', seq: 4 } });
    expect(
      (await row('SELECT count(*) n FROM session_events WHERE session_id = ?', view.sessionId))!.n,
    ).toBe(4);
  });

  it('works without credits: free steps, a stored hint, the answer and self-marking', async () => {
    const t = await setupStudy(or, '0');
    // "Partnership deed" has an MCQ in the question bank: marked by code.
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Partnership deed' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    const n0 = or.requests.length;
    const refused = await act(t.student.jar, view, 'ask', { fields: { text: 'What is a deed?' } });
    expect(refused).toMatchObject({ status: 402, code: 'insufficient_credits', view: { seq: 1 } });
    view = (await act(t.student.jar, view, 'ready')).view;
    expect(view.actions.filter((a: any) => a.id === 'answer').map((a: any) => a.label)).toEqual([
      '(a) An oral promise',
      '(b) A written agreement',
      '(c) A balance sheet',
      '(d) A ledger',
    ]);
    expect(view.forms).toEqual([]);
    view = (await act(t.student.jar, view, 'hint')).view;
    expect(text(view)).toContain('Think about: reputation, future profits.');
    view = (await act(t.student.jar, view, 'answer', { value: 0 })).view;
    expect(view.node).toBe('check');
    view = (await act(t.student.jar, view, 'answer', { value: 1 })).view;
    expect(view.node).toBe('feedback');
    view = (await act(t.student.jar, view, 'finish')).view;
    expect(view).toMatchObject({ status: 'done', billedMicro: 0 });
    expect(text(view)).toContain('right, with 1 hint');
    expect(or.requests.length).toBe(n0);
    expect(mcqCorrectIndex(['Cash', 'Cash and bank', 'Stock'], 'Cash and bank [S1]')).toBe(1);
    expect(mcqCorrectIndex(['A', 'B'], 'neither')).toBeNull();
  });

  it('pauses an idle session and picks it up again', async () => {
    const t = await setupStudy(or);
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    const stub = stubOf(view.sessionId);
    await runInDurableObject(stub, async (_agent, state) => {
      const s = (await state.storage.get<StoredSession>('s'))!;
      await state.storage.put('s', { ...s, updatedAt: s.updatedAt - 31 * 60_000 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      (await row('SELECT status FROM study_sessions WHERE id = ?', view.sessionId))!.status,
    ).toBe('paused');
    const home = await json(await call('GET', '/api/sessions/home', { jar: t.student.jar }));
    expect(home.resume).toMatchObject({ id: view.sessionId, status: 'paused' });
    view = (await act(t.student.jar, view, 'ready')).view;
    expect(view).toMatchObject({ node: 'check', status: 'active' });
    expect(
      (await row('SELECT status FROM study_sessions WHERE id = ?', view.sessionId))!.status,
    ).toBe('active');
  });
});

describe('safety', () => {
  const verifyParent = async (t: Study) => {
    await call('PUT', '/api/me/parent-contact', {
      jar: t.student.jar,
      body: {
        name: 'Meera Rao',
        email: 'meera.parent@example.com',
        relationship: 'mother',
        acknowledgeSafetyAlerts: true,
      },
    });
    await env.DB.prepare("UPDATE parent_contacts SET consent_status = 'verified'").run();
  };
  const alerts = () => memoryOutbox.filter((m) => m.tag.startsWith('safety_'));

  it('distress in a session: fixed response, no model call, the parent is told once, nothing they wrote is kept', async () => {
    const t = await setupStudy(or);
    await verifyParent(t);
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    const n0 = or.requests.length;
    const said = 'whats the point, i want to die';
    view = (await act(t.student.jar, view, 'ask', { fields: { text: said } })).view;
    expect(view).toMatchObject({ node: 'safety', status: 'handoff' });
    expect(text(view)).toContain('14416');
    expect(text(view)).toContain("we've let your parent or guardian know");
    expect(view.actions).toEqual([]);
    expect(view.forms).toEqual([]);
    expect(or.requests.length).toBe(n0);

    expect(alerts()).toHaveLength(1);
    const mail = alerts()[0]!;
    expect(mail).toMatchObject({ to: 'meera.parent@example.com', tag: 'safety_parent_alert' });
    expect(mail.text).toContain('Asha Rao');
    expect(mail.text).not.toContain('die');
    const logged = await env.DB.prepare('SELECT * FROM safety_events').all<Record<string, any>>();
    expect(logged.results).toMatchObject([
      { source: 'session', detector: 'rules', rule: 'self_harm', notified: 'parent' },
    ]);
    expect(text(logged.results)).not.toContain('die');
    expect(
      text(await row('SELECT * FROM study_sessions WHERE id = ?', view.sessionId)),
    ).not.toContain('die');

    // The same in Ask an hour later: the fixed response again, no second email (12-hour rule).
    const asked = await json(
      await call('POST', '/api/ask', {
        jar: t.student.jar,
        body: { question: 'I hate my life, explain goodwill', stream: false },
      }),
    );
    expect(asked).toMatchObject({ type: 'handoff' });
    expect(asked.helplines.join(' ')).toContain('14416');
    expect(asked.told).toContain('parent or guardian');
    expect(or.requests.length).toBe(n0);
    expect(alerts()).toHaveLength(1);
    const streamed = await sse(
      await call('POST', '/api/ask', { jar: t.student.jar, body: { question: 'i want to die' } }),
    );
    expect(streamed).toMatchObject([{ type: 'handoff' }]);
    expect((await row('SELECT count(*) n FROM safety_events'))!.n).toBe(3);

    const admin = await json(await call('GET', '/api/admin/safety', { jar: t.admin.jar }));
    expect(admin.events).toHaveLength(3);
    expect(admin.events[0]).toMatchObject({ name: 'Asha Rao', notified: 'suppressed' });
    expect((await call('GET', '/api/admin/safety', { jar: t.teacher.jar })).status).toBe(403);
  });

  it('third net: wording the rules miss is flagged by the model that reads it; its reply is never shown', async () => {
    const t = await setupStudy(or);
    await verifyParent(t);
    const base = or.replyFor!;
    or.replyFor = (body) => {
      const system = String(body.messages?.[0]?.content ?? '');
      const user = String(body.messages?.at(-1)?.content ?? '');
      if (user.includes('fading away'))
        return system.includes('JSON') ? '{"distress":true}' : 'SAFETY_HANDOFF:';
      return base(body);
    };
    // The prompts ask every session model to flag instead of answering.
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    const events = await sse(
      await call('POST', `/api/sessions/${view.sessionId}/act`, {
        jar: t.student.jar,
        body: {
          action: 'ask',
          seq: view.seq,
          fields: { text: 'lately I keep fading away from everything' },
        },
      }),
    );
    expect(or.systems.at(-1)).toContain('reply with exactly "SAFETY_HANDOFF:"');
    expect(events.filter((e) => e.type === 'delta')).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'view',
      view: { node: 'safety', status: 'handoff' },
    });
    expect(text(events.at(-1))).not.toContain('SAFETY_HANDOFF');
    // The call was made, so it is accounted for; the parent is told.
    expect(events.at(-1).view.billedMicro).toBeGreaterThan(0);
    expect(alerts()).toMatchObject([{ tag: 'safety_parent_alert' }]);
    expect(await row('SELECT detector, rule, notified FROM safety_events')).toEqual({
      detector: 'model',
      rule: 'tutor_flag',
      notified: 'parent',
    });

    // The same through a JSON call (marking the check answer).
    let second = (
      await json(await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }))
    ).view;
    second = (await act(t.student.jar, second, 'start')).view;
    second = (await act(t.student.jar, second, 'ready')).view;
    second = (
      await act(t.student.jar, second, 'answer', { fields: { text: 'I am just fading away' } })
    ).view;
    expect(second).toMatchObject({ node: 'safety', status: 'handoff' });
    expect(or.systems.at(-1)).toContain('reply with exactly {"distress":true}');
  });

  it("where email only goes to a log (staging), the learner isn't told that someone was informed", async () => {
    const t = await setupStudy(or);
    await verifyParent(t);
    const logOnly = new ConsoleNotifier(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await handoff(
      createDb(env.DB),
      logOnly,
      {
        id: t.student.id,
        name: 'Asha Rao',
        email: t.student.email,
        role: 'student',
        twoFactorEnabled: true,
      },
      { source: 'ask', rule: 'self_harm', detector: 'rules' },
    );
    expect(h.told).toBe('none');
    expect((await row('SELECT notified FROM safety_events'))!.notified).toBe('none');
    // On LOCAL the terminal is the developer's inbox, so there it counts.
    expect(
      createNotifier({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'x', APP_ENV: 'staging' }).delivers,
    ).toBe(false);
    expect(
      createNotifier({ EMAIL_PROVIDER: 'console', EMAIL_FROM: 'x', APP_ENV: 'development' })
        .delivers,
    ).toBe(true);
  });

  it('when someone is hurting the learner, the institution is told, not the parent', async () => {
    const t = await setupStudy(or);
    await verifyParent(t);
    const asked = await json(
      await call('POST', '/api/ask', {
        jar: t.student.jar,
        body: { question: 'my father beats me when I get low marks', stream: false },
      }),
    );
    expect(asked.type).toBe('handoff');
    expect(asked.told).toContain("institution's coordinator");
    expect(alerts()).toMatchObject([{ to: t.poc.email, tag: 'safety_poc_alert' }]);
    expect(alerts()[0]!.text).toContain('NOT contacted the parent');
  });

  it('without a confirmed parent the institution is told; "too much" offers a smaller plan instead of a reply', async () => {
    const t = await setupStudy(or);
    let { view } = await json(
      await start(t.student.jar, { journey: 'explain', chapter: 1, topic: 'Goodwill' }),
    );
    view = (await act(t.student.jar, view, 'start')).view;
    const n0 = or.requests.length;
    view = (
      await act(t.student.jar, view, 'ask', { fields: { text: 'this is too much, I will fail' } })
    ).view;
    expect(view.node).toBe('reduce_scope');
    expect(view.actions.map((a: any) => a.label)).toEqual([
      'Just one question, then done',
      'Carry on as planned',
      'Stop here for today',
    ]);
    expect(or.requests.length).toBe(n0);
    expect(alerts()).toHaveLength(0);
    view = (await act(t.student.jar, view, 'small')).view;
    expect(view.node).toBe('check');

    // A card is learner text too.
    const saved = await json(
      await call('POST', '/api/learner/artefacts', {
        jar: t.student.jar,
        body: { chapter: 1, front: 'Why bother', back: 'nobody cares about me' },
      }),
    );
    expect(saved.handoff.told).toContain("institution's coordinator");
    expect(alerts()).toMatchObject([{ to: t.poc.email, tag: 'safety_poc_alert' }]);
    expect((await row('SELECT count(*) n FROM learner_artefacts'))!.n).toBe(0);
  });
});

describe('memorisation session', () => {
  it('goes through the cards, makes a memory hook from declared interests, times a write-out and schedules reviews', async () => {
    const t = await setupStudy(or);
    const jar = t.student.jar;
    expect(
      (
        await call('PUT', '/api/learner/interests', {
          jar,
          body: { interests: ['Cricket', 'Music'] },
        })
      ).status,
    ).toBe(200);
    const own = await json(
      await call('POST', '/api/learner/artefacts', {
        jar,
        body: { chapter: 1, topic: 'Goodwill', front: 'My own question', back: 'My own answer' },
      }),
    );

    let { view } = await json(await start(jar, { journey: 'memorise', chapter: 1 }));
    expect(view).toMatchObject({ node: 'brief', title: '1. Partnership basics' });
    expect(text(view)).toContain('4 cards today');
    expect(text(view)).toContain('0 due for review, 4 new');
    view = (await act(jar, view, 'start')).view;
    expect(view.blocks[0]).toMatchObject({ type: 'card', front: 'What is goodwill?' });
    expect(view.blocks[0].back).toBeUndefined();
    view = (await act(jar, view, 'show')).view;
    expect(view.blocks[0].back).toBe('Value of reputation');

    // Memory hook: ideas use the learner's interests; the learner picks one.
    view = (await act(jar, view, 'hook')).view;
    const billedBefore = view.billedMicro;
    view = (await act(jar, view, 'ideas', { fields: { text: 'good name' } })).view;
    expect(or.systems.at(-1)).toContain('The student likes: Cricket, Music.');
    expect(text(view)).toContain('A cricketer with a big name sells more bats');
    expect(view.billedMicro).toBeGreaterThan(billedBefore);
    view = (await act(jar, view, 'use_idea', { value: 0 })).view;
    expect(view.node).toBe('reveal');
    expect(text(view)).toContain('GOOD name = GOODwill');

    // Forgot the first, knew the rest: the first comes back once at the end.
    view = (await act(jar, view, 'rate', { value: 'forgot' })).view;
    for (let i = 0; i < 3; i++) {
      view = (await act(jar, view, 'show')).view;
      view = (await act(jar, view, 'rate', { value: 'got' })).view;
    }
    expect(view.node).toBe('recall');
    expect(text(view)).toContain('This one again');
    view = (await act(jar, view, 'show')).view;
    view = (await act(jar, view, 'rate', { value: 'got' })).view;

    // Timed write-out on paper.
    expect(view.node).toBe('write_out');
    expect(text(view)).toContain('2.3 min in the paper');
    view = (await act(jar, view, 'write')).view;
    expect(view.blocks.at(-1)).toMatchObject({ type: 'timer', targetMinutes: 2.3 });
    view = (await act(jar, view, 'done_writing')).view;
    expect(text(view)).toContain('inside the time');
    view = (await act(jar, view, 'self_check', { value: 'most' })).view;
    expect(view).toMatchObject({ node: 'micro_win', status: 'done' });
    expect(text(view)).toContain('You went through 4 cards: 4 you knew, 0 almost, 0 forgotten.');

    // Reviews: the forgotten card stays in box 1 (tomorrow) although it was right on the repeat.
    const reviews = await env.DB.prepare(
      'SELECT card_key k, box, reviews, lapses, last_rating r FROM card_reviews ORDER BY reviews DESC, card_key',
    ).all<Record<string, any>>();
    expect(reviews.results).toHaveLength(4);
    expect(reviews.results[0]).toMatchObject({ box: 1, reviews: 2, lapses: 1, r: 'got' });
    expect(reviews.results.slice(1).every((x) => x.box === 2 && x.reviews === 1)).toBe(true);
    expect(reviews.results.map((x) => x.k)).toContain(`own:${own.id}`);

    const locker = await json(await call('GET', '/api/learner/artefacts', { jar }));
    expect(locker.artefacts.map((a: any) => a.kind).sort()).toEqual(['card', 'mnemonic']);
    const progress = await json(await call('GET', '/api/learner/progress', { jar }));
    expect(progress.summary).toMatchObject({
      cards: { reviewed: 4, known: 0, due: 0 },
      ownCards: 1,
      hooks: 1,
      sessionsFinished: 1,
    });

    // Nothing is due today any more: no empty session is started.
    const none = await start(jar, { journey: 'memorise', chapter: 1 });
    expect(none.status).toBe(400);
    expect((await json(none)).error.message).toContain('No cards are due');

    // The learner edits and removes their own card.
    const edited = await call('PATCH', `/api/learner/artefacts/${own.id}`, {
      jar,
      body: { back: 'A better answer' },
    });
    expect((await json(edited)).content).toEqual({
      front: 'My own question',
      back: 'A better answer',
    });
    const other = await createSignedInUser('student');
    expect(
      (await call('DELETE', `/api/learner/artefacts/${own.id}`, { jar: other.jar })).status,
    ).toBe(404);
    expect((await call('DELETE', `/api/learner/artefacts/${own.id}`, { jar })).status).toBe(200);
    expect(
      (await json(await call('GET', '/api/learner/artefacts', { jar }))).artefacts,
    ).toHaveLength(1);
  });
});
