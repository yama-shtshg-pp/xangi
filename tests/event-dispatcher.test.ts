import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventDispatcher,
  type EventDispatcherOptions,
  buildEventPrompt,
  isLoadAcceptable,
  loadEventConfig,
} from '../src/event-dispatcher.js';
import { EventStore, type AgentEvent } from '../src/event-store.js';
import type { EventSource } from '../src/event-source-github.js';
import type { SessionActivity } from '../src/tmux-launcher.js';
import type { IssueRef, IssueState } from '../src/run-after.js';

function makeEvent(n: number): AgentEvent {
  return {
    source: 'github-issue',
    id: `o/a#${n}`,
    title: `issue ${n}`,
    body: `body ${n}`,
    url: `https://github.com/o/a/issues/${n}`,
    labels: ['agent'],
  };
}

describe('EventDispatcher', () => {
  let dir: string;
  let store: EventStore;
  let events: AgentEvent[];
  let source: EventSource;
  let notify: ReturnType<typeof vi.fn>;
  let loadOk: boolean;
  /** 動いている tmux セッションの名前（isAlive のモック） */
  let alive: Set<string>;
  let launch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'event-dispatcher-'));
    store = new EventStore(join(dir, 'events.json'));
    events = [];
    source = { name: 'fake', poll: vi.fn(async () => events) };
    notify = vi.fn().mockResolvedValue(undefined);
    loadOk = true;
    alive = new Set();
    launch = vi.fn(async (_prompt: string, event: AgentEvent) => {
      const sessionName = `cc-a-issue${event.id.split('#')[1]}`;
      alive.add(sessionName);
      return { sessionName, launched: true };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDispatcher(overrides: Partial<EventDispatcherOptions> = {}) {
    return new EventDispatcher({
      sources: [source],
      store,
      launch,
      isAlive: async (name) => alive.has(name),
      notify,
      maxConcurrent: 1,
      isLoadAcceptable: () => loadOk,
      ...overrides,
    });
  }

  const messages = () => notify.mock.calls.map((c) => c[0] as string);

  describe('入力待ち', () => {
    let activity: Map<string, SessionActivity>;

    beforeEach(() => {
      activity = new Map();
    });

    function makeLifecycleDispatcher(overrides: Partial<EventDispatcherOptions> = {}) {
      return makeDispatcher({
        getActivity: (name) => activity.get(name) ?? 'unknown',
        ...overrides,
      });
    }

    it('入力待ちのセッションは同時起動数に数えず、次を起動する', async () => {
      events = [makeEvent(1)];
      const dispatcher = makeLifecycleDispatcher();
      await dispatcher.poll();
      activity.set('cc-a-issue1', 'idle');
      events = [makeEvent(1), makeEvent(2)];
      await dispatcher.poll();

      expect(launch).toHaveBeenCalledTimes(2);
      expect(store.countByStatus('running')).toBe(2);
    });

    it('作業中と、記録のない（unknown）セッションは同時起動数に数える', async () => {
      events = [makeEvent(1)];
      const dispatcher = makeLifecycleDispatcher({ maxConcurrent: 2 });
      await dispatcher.poll();
      events = [makeEvent(1), makeEvent(2)];
      await dispatcher.poll();
      activity.set('cc-a-issue1', 'busy');
      events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      await dispatcher.poll();

      expect(launch).toHaveBeenCalledTimes(2);
      expect(store.countByStatus('queued')).toBe(1);
    });

    it('issue が close されても、セッションは閉じず起動中のままにする', async () => {
      events = [makeEvent(1)];
      const dispatcher = makeLifecycleDispatcher();
      await dispatcher.poll();
      activity.set('cc-a-issue1', 'idle');
      events = [];
      await dispatcher.poll();

      expect(alive.has('cc-a-issue1')).toBe(true);
      expect(store.countByStatus('running')).toBe(1);
    });
  });

  it('新しいイベントで起動し、セッション名を残して起動中にする', async () => {
    events = [makeEvent(1)];
    await makeDispatcher().poll();

    expect(launch).toHaveBeenCalledWith(buildEventPrompt(makeEvent(1)), makeEvent(1));
    const running = store.listByStatus('running');
    expect(running.map((r) => r.sessionName)).toEqual(['cc-a-issue1']);
    expect(messages()[0]).toContain('🚀 起動しました: o/a#1');
    expect(messages()[0]).toContain('tmux attach -t cc-a-issue1');
  });

  it('セッションが残っている間は起動中のまま、なくなったら終了にして通知する', async () => {
    events = [makeEvent(1)];
    const dispatcher = makeDispatcher();
    await dispatcher.poll();
    await dispatcher.poll();
    expect(store.countByStatus('running')).toBe(1);

    alive.delete('cc-a-issue1');
    await dispatcher.poll();
    expect(store.countByStatus('done')).toBe(1);
    expect(messages().some((m) => m.startsWith('🏁 終了: o/a#1'))).toBe(true);
  });

  it('同じイベントがポーリングで何度返っても 1 回しか起動しない', async () => {
    events = [makeEvent(1)];
    const dispatcher = makeDispatcher();
    await dispatcher.poll();
    alive.clear();
    await dispatcher.poll();
    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('同時起動数は起動中のセッションの数で数え、閉じられたら古い順に次を起動する', async () => {
    events = [makeEvent(1), makeEvent(2)];
    const dispatcher = makeDispatcher();

    await dispatcher.poll();
    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.countByStatus('queued')).toBe(1);

    alive.delete('cc-a-issue1');
    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][1].id).toBe('o/a#2');
  });

  it('同時起動数が 2 なら 2 件まで起動する', async () => {
    events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    await makeDispatcher({ maxConcurrent: 2 }).poll();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(store.countByStatus('running')).toBe(2);
  });

  it('負荷が高い間は起動せず 1 回だけ通知し、下がったら次のポーリングで起動する', async () => {
    events = [makeEvent(1)];
    loadOk = false;
    const dispatcher = makeDispatcher();

    await dispatcher.poll();
    await dispatcher.poll();
    expect(launch).not.toHaveBeenCalled();
    const deferMessages = messages().filter((m) => m.startsWith('⏳'));
    expect(deferMessages).toHaveLength(1);
    expect(deferMessages[0]).toContain('1 件');

    loadOk = true;
    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('起動に失敗したら failed にして通知し、次のイベントに進む', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1), makeEvent(2)];
    const ok = launch.getMockImplementation()!;
    launch.mockImplementation(async (prompt: string, event: AgentEvent) => {
      if (event.id === 'o/a#1') throw new Error('tmux: command not found');
      return ok(prompt, event);
    });

    await makeDispatcher().poll();

    expect(store.countByStatus('failed')).toBe(1);
    expect(store.countByStatus('running')).toBe(1);
    expect(messages().some((m) => m.includes('❌ 起動に失敗: o/a#1'))).toBe(true);
  });

  it('同じ名前のセッションがすでにあれば起動せず、起動しなかったと記録して次に進む', async () => {
    events = [makeEvent(1), makeEvent(2)];
    alive.add('cc-a-issue1');
    launch.mockImplementationOnce(async () => ({ sessionName: 'cc-a-issue1', launched: false }));

    await makeDispatcher().poll();

    expect(store.countByStatus('failed')).toBe(1);
    expect(store.listByStatus('running').map((r) => r.event.id)).toEqual(['o/a#2']);
    expect(messages()[0]).toContain('⚠️ 同じ名前の tmux セッション cc-a-issue1');
  });

  it('セッションの有無を確かめられないときは起動中のままにし、次を起動しない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1), makeEvent(2)];
    let broken = false;
    const dispatcher = makeDispatcher({
      isAlive: async (name) => {
        if (broken) throw new Error('tmux crashed');
        return alive.has(name);
      },
    });
    await dispatcher.poll();

    broken = true;
    await dispatcher.poll();
    expect(store.countByStatus('running')).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('起動と終了の通知は、イベントの通知先に送る', async () => {
    events = [{ ...makeEvent(1), notifyChannelId: '999' }];
    const dispatcher = makeDispatcher();
    await dispatcher.poll();
    alive.clear();
    await dispatcher.poll();

    expect(notify.mock.calls.map((c) => c[1])).toEqual(['999', '999']);
  });

  it('通知に失敗しても起動は続ける', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1)];
    notify.mockRejectedValue(new Error('Missing Access'));

    await makeDispatcher().poll();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.countByStatus('running')).toBe(1);
  });

  it('イベント源の失敗でポーリング全体を止めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: EventSource = {
      name: 'broken',
      poll: vi.fn().mockRejectedValue(new Error('down')),
    };
    events = [makeEvent(1)];
    await makeDispatcher({ sources: [broken, source] }).poll();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('start: 初回のポーリングが失敗しても、次の回からはポーリングする', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poll = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockResolvedValue([]);
    const dispatcher = makeDispatcher();
    // poll() 自体を失敗させる（イベント源の失敗は poll() の中で吸収されるため）
    vi.spyOn(dispatcher, 'poll').mockImplementation(poll);

    try {
      await dispatcher.start(1000);
      expect(error).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally {
      dispatcher.stop();
      vi.useRealTimers();
    }
  });

  describe('本文の起動日時', () => {
    const withRunAt = (n: number, value: string): AgentEvent => ({
      ...makeEvent(n),
      body: `本文\nxangi-run-at: ${value}`,
    });

    it('日時より前は積まず、過ぎた最初のポーリングで起動する', async () => {
      events = [withRunAt(1, '2026-11-20')];
      let now = new Date('2026-11-19T23:59:00Z'); // JST 08:59
      const dispatcher = makeDispatcher({ now: () => now });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(store.has(events[0])).toBe(false);

      now = new Date('2026-11-20T00:00:00Z'); // JST 09:00
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('指定のない issue はすぐ起動し、日時より前の issue は後続を待たせない', async () => {
      events = [withRunAt(1, '2026-12-01'), makeEvent(2)];
      await makeDispatcher({ now: () => new Date('2026-11-08T00:00:00Z') }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1].id).toBe('o/a#2');
    });

    it('読めない値なら起動せず、同じ値の警告は 1 回だけ出す', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withRunAt(1, '2026.11.20')];
      const dispatcher = makeDispatcher();
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);

      events = [withRunAt(1, '2026-11-01')];
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    describe('done の issue の日時を書き換えたとき', () => {
      /** 起動したセッションを閉じ、次のポーリングで done にする */
      const finish = (n: number) => alive.delete(`cc-a-issue${n}`);

      it('新しい日時を過ぎたら、新しい本文で起動し直し、区別できるログを出す', async () => {
        const log = vi.mocked(console.log);
        events = [withRunAt(1, '2026-11-10')];
        let now = new Date('2026-11-10T00:00:00Z');
        const dispatcher = makeDispatcher({ now: () => now });
        await dispatcher.poll();
        finish(1);
        events = [withRunAt(1, '2026-11-17')];
        await dispatcher.poll();
        expect(store.countByStatus('done')).toBe(1);
        expect(launch).toHaveBeenCalledTimes(1);

        now = new Date('2026-11-17T00:00:00Z'); // JST 09:00
        await dispatcher.poll();
        expect(launch).toHaveBeenCalledTimes(2);
        expect(launch.mock.calls[1][0]).toContain('xangi-run-at: 2026-11-17');
        expect(log).toHaveBeenCalledWith(
          '[event-dispatcher] Requeued rescheduled github-issue:o/a#1 (xangi-run-at changed)'
        );
        expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Requeued updated'));

        // 起動し直したあとは、同じ値のままなら 3 回目は起動しない
        finish(1);
        await dispatcher.poll();
        await dispatcher.poll();
        expect(launch).toHaveBeenCalledTimes(2);
      });

      it('起動中に書き換えた日時は、終わったあとその日時に起動する', async () => {
        events = [withRunAt(1, '2026-11-10')];
        let now = new Date('2026-11-10T00:00:00Z');
        const dispatcher = makeDispatcher({ now: () => now });
        await dispatcher.poll();
        events = [withRunAt(1, '2026-11-10T08:00')];
        now = new Date('2026-11-10T01:00:00Z');
        await dispatcher.poll();
        expect(launch).toHaveBeenCalledTimes(1);

        finish(1);
        await dispatcher.poll(); // done にしたポーリングで、そのまま積み直す
        expect(launch).toHaveBeenCalledTimes(2);
      });

      it('行がない・同じ日時・読めない値のときは起動し直さない', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        events = [withRunAt(1, '2026-11-10')];
        const dispatcher = makeDispatcher({ now: () => new Date('2026-11-20T00:00:00Z') });
        await dispatcher.poll();
        finish(1);
        await dispatcher.poll();

        for (const body of [
          '本文を直しただけ',
          '本文\nxangi-run-at: 2026-11-10T09:00', // 書き方が違っても同じ日時
          '本文\nxangi-run-at: 2026/13/15',
        ]) {
          events = [{ ...makeEvent(1), body }];
          await dispatcher.poll();
        }
        expect(launch).toHaveBeenCalledTimes(1);
      });

      it('起動し直すときは、作業を始められるかを判定し直さない', async () => {
        const checkReadiness = vi.fn(async () => ({ notReady: false }));
        events = [withRunAt(1, '2026-11-10')];
        const dispatcher = makeDispatcher({
          now: () => new Date('2026-11-20T00:00:00Z'),
          checkReadiness,
        });
        await dispatcher.poll();
        expect(checkReadiness).toHaveBeenCalledTimes(1);
        finish(1);
        await dispatcher.poll();

        checkReadiness.mockResolvedValue({ notReady: true, missing: '目的' } as never);
        events = [withRunAt(1, '2026-11-17')];
        await dispatcher.poll();
        expect(checkReadiness).toHaveBeenCalledTimes(1);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(store.listByStatus('needs_info')).toHaveLength(0);
      });

      it('古い記録は、更新後に未来の日時へ書き換えれば、その日時に起動する', async () => {
        const event = withRunAt(1, '2026-11-10');
        store.enqueue(event);
        store.setRunning(event, 'cc-a-issue1');
        store.setStatus(event, 'done');
        // runAt を持たない古い記録にする
        delete (store.listByStatus('done')[0] as { runAt?: unknown }).runAt;

        events = [event];
        let now = new Date('2026-11-15T00:00:00Z');
        const dispatcher = makeDispatcher({ now: () => now });
        await dispatcher.poll(); // 更新後の最初のポーリング。今の値（11-10）を前回の値にする
        expect(launch).not.toHaveBeenCalled();

        events = [withRunAt(1, '2026-11-20')];
        await dispatcher.poll();
        now = new Date('2026-11-20T00:00:00Z');
        await dispatcher.poll();
        expect(launch).toHaveBeenCalledTimes(1);
      });

      it('行のない issue でも、あとから過ぎた日時を書けば起動し直す', async () => {
        events = [makeEvent(1)];
        const dispatcher = makeDispatcher({ now: () => new Date('2026-11-20T00:00:00Z') });
        await dispatcher.poll();
        finish(1);
        await dispatcher.poll();
        events = [withRunAt(1, '2026-11-19')];
        await dispatcher.poll();
        expect(launch).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('本文の xangi-run-after', () => {
    /** 待たれている issue の状態（キーは owner/repo#番号） */
    let states: Map<string, IssueState | Error>;
    let getIssueState: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      states = new Map();
      getIssueState = vi.fn(async (issue: IssueRef) => {
        const state = states.get(`${issue.repo}#${issue.number}`);
        if (state instanceof Error) throw state;
        if (!state) throw new Error('not found');
        return state;
      });
    });

    const withRunAfter = (n: number, line: string): AgentEvent => ({
      ...makeEvent(n),
      body: `本文\n${line}`,
    });
    const open: IssueState = { state: 'OPEN', stateReason: '' };
    const completed: IssueState = { state: 'CLOSED', stateReason: 'COMPLETED' };
    const notPlanned: IssueState = { state: 'CLOSED', stateReason: 'NOT_PLANNED' };

    it('待つ issue がすべて completed で閉じるまで積まず、閉じたあとのポーリングで起動する', async () => {
      events = [withRunAfter(3, 'xangi-run-after: #1, other/b#2')];
      states.set('o/a#1', completed);
      states.set('other/b#2', open);
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(store.has(events[0])).toBe(false);

      states.set('other/b#2', completed);
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
      // completed と確かめた #1 は 2 回目のポーリングで gh を呼ばない
      const calls = getIssueState.mock.calls.map((c) => `${c[0].repo}#${c[0].number}`);
      expect(calls).toEqual(['o/a#1', 'other/b#2', 'other/b#2']);
    });

    it('待っている issue があっても、後続の issue は待たせない', async () => {
      events = [withRunAfter(2, 'xangi-run-after: #1'), makeEvent(3)];
      states.set('o/a#1', open);
      await makeDispatcher({ getIssueState }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1].id).toBe('o/a#3');
    });

    it('not planned で閉じたら起動せず、通知は 1 回だけ。開き直して閉じたら、また知らせる', async () => {
      events = [withRunAfter(2, 'xangi-run-after: #1')];
      states.set('o/a#1', notPlanned);
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toContain('o/a#1');
      expect(messages()[0]).toContain('NOT_PLANNED');

      states.set('o/a#1', open);
      await dispatcher.poll();
      states.set('o/a#1', notPlanned);
      await dispatcher.poll();
      expect(messages()).toHaveLength(2);
    });

    it('状態を取れないときは起動せず、警告は 1 回だけ出す', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withRunAfter(2, 'xangi-run-after: #1')];
      states.set('o/a#1', new Error('Could not resolve to an issue'));
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Could not resolve to an issue');
    });

    it('読めない値なら gh を呼ばずに起動せず、警告は 1 回だけ。直したら起動する', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withRunAfter(2, 'xangi-run-after: 1')];
      states.set('o/a#1', completed);
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(getIssueState).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);

      events = [withRunAfter(2, 'xangi-run-after: #1')];
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('起動済みの issue は、待つ issue が not planned になっても確かめ直さず、知らせない', async () => {
      events = [withRunAfter(2, 'xangi-run-after: #1')];
      states.set('o/a#1', completed);
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
      notify.mockClear();
      getIssueState.mockClear();

      alive.clear();
      states.set('o/a#1', notPlanned);
      await dispatcher.poll(); // done になる
      // xangi の再起動と同じく、completed のキャッシュを持たない dispatcher で確かめる
      await makeDispatcher({ getIssueState }).poll();
      expect(getIssueState).not.toHaveBeenCalled();
      expect(messages().some((m) => m.includes('起動しません'))).toBe(false);
    });

    it('同じ issue を複数の issue が待っていても、1 回のポーリングで gh を呼ぶのは 1 回だけ', async () => {
      events = [withRunAfter(2, 'xangi-run-after: #1'), withRunAfter(3, 'xangi-run-after: #1')];
      states.set('o/a#1', open);
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      expect(getIssueState).toHaveBeenCalledTimes(1);
      await dispatcher.poll();
      expect(getIssueState).toHaveBeenCalledTimes(2);
    });

    it('PR（MERGED）や自分の番号を書いたら起動せず、警告は 1 回だけ出す', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withRunAfter(2, 'xangi-run-after: #1'), withRunAfter(3, 'xangi-run-after: #3')];
      states.set('o/a#1', { state: 'MERGED', stateReason: '' });
      const dispatcher = makeDispatcher({ getIssueState });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toContain('MERGED');
      expect(warn.mock.calls[1][0]).toContain('refers to itself');
    });

    it('状態を取る関数がなければ起動しない', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withRunAfter(2, 'xangi-run-after: #1')];
      await makeDispatcher().poll();
      expect(launch).not.toHaveBeenCalled();
    });

    it('xangi-run-at と両方あれば、両方の条件を満たしてから起動する', async () => {
      events = [withRunAfter(2, 'xangi-run-after: #1\nxangi-run-at: 2026-11-20')];
      states.set('o/a#1', completed);
      let now = new Date('2026-11-19T00:00:00Z');
      const dispatcher = makeDispatcher({ getIssueState, now: () => now });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      // 日時前は gh を呼ばない
      expect(getIssueState).not.toHaveBeenCalled();

      now = new Date('2026-11-20T00:00:00Z');
      states.set('o/a#1', open);
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();

      states.set('o/a#1', completed);
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });
  });

  describe('新しい書き方の起動日時', () => {
    const created = '2026-11-01T00:00:00Z';
    const withLine = (n: number, line: string, createdAt: string | null = created) => ({
      ...makeEvent(n),
      body: `本文\n${line}`,
      ...(createdAt ? { createdAt } : {}),
    });

    it('起動: 11/20 14時 は、createdAt の年で、JST 14:00 を過ぎてから起動する', async () => {
      events = [withLine(1, '起動: 11/20 14時')];
      let now = new Date('2026-11-20T04:59:00Z');
      const dispatcher = makeDispatcher({ now: () => now });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      now = new Date('2026-11-20T05:00:00Z');
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('新しい書き方に書き換えたときも、done の issue を起動し直す', async () => {
      events = [withLine(1, 'xangi-run-at: 2026-11-10')];
      const dispatcher = makeDispatcher({ now: () => new Date('2026-11-17T00:00:00Z') });
      await dispatcher.poll();
      alive.clear();
      await dispatcher.poll();
      expect(store.countByStatus('done')).toBe(1);
      events = [withLine(1, '起動日：11月17日')];
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(2);
    });

    it('createdAt のない event（古い記録）でも壊れない', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [withLine(1, '起動: 2026-11-10', null), withLine(2, '起動: 11/10', null)];
      await makeDispatcher({ now: () => new Date('2026-11-20T00:00:00Z') }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1].id).toBe('o/a#1');
    });
  });

  describe('Blocked by', () => {
    type Blocker = { issue: IssueRef; state: IssueState };
    let blockers: Map<string, Blocker[] | Error>;
    let getBlockedBy: ReturnType<typeof vi.fn>;
    let getIssueState: ReturnType<typeof vi.fn>;
    const open: IssueState = { state: 'OPEN', stateReason: '' };
    const completed: IssueState = { state: 'CLOSED', stateReason: 'COMPLETED' };
    const blocker = (n: number, state: IssueState, repo = 'o/a'): Blocker => ({
      issue: { repo, number: n },
      state,
    });

    beforeEach(() => {
      blockers = new Map();
      getBlockedBy = vi.fn(async (event: AgentEvent) => {
        const v = blockers.get(event.id) ?? [];
        if (v instanceof Error) throw v;
        return v;
      });
      getIssueState = vi.fn(async () => completed);
    });

    it('Blocked by の issue がすべて completed で閉じるまで積まず、閉じたら起動する', async () => {
      events = [makeEvent(3)];
      blockers.set('o/a#3', [blocker(1, completed), blocker(2, open, 'other/b')]);
      const dispatcher = makeDispatcher({ getBlockedBy, getIssueState });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(store.has(events[0])).toBe(false);

      blockers.set('o/a#3', [blocker(1, completed), blocker(2, completed, 'other/b')]);
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
      // 状態は Blocked by の応答から取る
      expect(getIssueState).not.toHaveBeenCalled();
    });

    it('xangi-run-after と両方あれば、両方に書いた issue をすべて待つ', async () => {
      events = [{ ...makeEvent(3), body: '待つ: #9' }];
      blockers.set('o/a#3', [blocker(1, completed)]);
      getIssueState.mockResolvedValue(open);
      const dispatcher = makeDispatcher({ getBlockedBy, getIssueState });
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();

      getIssueState.mockResolvedValue(completed);
      blockers.set('o/a#3', [blocker(1, open)]);
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();

      blockers.set('o/a#3', [blocker(1, completed)]);
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('同じ issue を両方に書いても、重複せず待つ（getIssueState は呼ばない）', async () => {
      events = [{ ...makeEvent(3), body: '待つ: #1' }];
      blockers.set('o/a#3', [blocker(1, completed)]);
      await makeDispatcher({ getBlockedBy, getIssueState }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(getIssueState).not.toHaveBeenCalled();
    });

    it('not planned / duplicate で閉じたら起動せず、通知は 1 回だけ。直し方は Blocked by から外す', async () => {
      events = [makeEvent(3)];
      blockers.set('o/a#3', [blocker(1, { state: 'closed', stateReason: 'not_planned' })]);
      const dispatcher = makeDispatcher({ getBlockedBy });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(messages()).toHaveLength(1);
      expect(messages()[0]).toContain('o/a#1');
      expect(messages()[0]).toContain('Blocked by');
      expect(messages()[0]).not.toContain('`xangi-run-after` の行を直して');

      blockers.set('o/a#3', [blocker(2, { state: 'closed', stateReason: 'duplicate' })]);
      await dispatcher.poll();
      expect(messages()).toHaveLength(2);
    });

    it('API が失敗したら起動せず、警告は 1 回だけ。直ったら起動する', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      events = [makeEvent(3)];
      blockers.set('o/a#3', new Error('HTTP 502'));
      const dispatcher = makeDispatcher({ getBlockedBy });
      await dispatcher.poll();
      await dispatcher.poll();
      expect(launch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('HTTP 502');

      blockers.set('o/a#3', []);
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('Blocked by も xangi-run-after もなければ、今までどおり起動する。getBlockedBy がなくても起動する', async () => {
      events = [makeEvent(1)];
      await makeDispatcher({ getBlockedBy }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      launch.mockClear();
      alive.clear();
      events = [makeEvent(2)];
      await makeDispatcher().poll();
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('一度積んだ issue は Blocked by を確かめ直さない（再起動と同じ新しい dispatcher でも）', async () => {
      events = [makeEvent(3)];
      blockers.set('o/a#3', [blocker(1, completed)]);
      await makeDispatcher({ getBlockedBy }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      getBlockedBy.mockClear();
      notify.mockClear();

      alive.clear();
      blockers.set('o/a#3', [blocker(1, { state: 'closed', stateReason: 'not_planned' })]);
      await makeDispatcher({ getBlockedBy }).poll();
      await makeDispatcher({ getBlockedBy }).poll();
      expect(getBlockedBy).not.toHaveBeenCalled();
      expect(messages().some((m) => m.includes('起動しません'))).toBe(false);
    });
  });

  describe('読めない値のコメント', () => {
    let comment: ReturnType<typeof vi.fn>;
    const withBody = (body: string): AgentEvent => ({ ...makeEvent(1), body });

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      comment = vi.fn().mockResolvedValue(undefined);
    });

    it('起動日時を読めなければ、読めなかった値と書ける形の例をコメントする。ログの警告も残す', async () => {
      events = [withBody('起動: あした')];
      await makeDispatcher({ comment }).poll();
      expect(launch).not.toHaveBeenCalled();
      expect(comment).toHaveBeenCalledTimes(1);
      const message = comment.mock.calls[0][1] as string;
      expect(message).toContain('あした');
      expect(message).toContain('起動: 2026-11-20 14:00');
      expect(message).toContain('起動: 11/20 14時');
      expect(console.warn).toHaveBeenCalled();
    });

    it('待つ issue を読めなければ、読めなかった値と書ける形の例をコメントする', async () => {
      events = [withBody('待つ: 12')];
      await makeDispatcher({
        comment,
        getIssueState: async () => ({ state: 'OPEN', stateReason: '' }),
      }).poll();
      expect(launch).not.toHaveBeenCalled();
      expect(comment).toHaveBeenCalledTimes(1);
      const message = comment.mock.calls[0][1] as string;
      expect(message).toContain('12');
      expect(message).toContain('待つ: #12, repo#3, https://github.com/owner/repo/issues/3');
    });

    it('同じ値なら 1 回だけ。xangi を再起動しても（新しい dispatcher と store）2 回目は書かない', async () => {
      events = [withBody('起動: あした')];
      await makeDispatcher({ comment }).poll();
      await makeDispatcher({ comment }).poll();
      const reloaded = new EventStore(join(dir, 'events.json'));
      await makeDispatcher({ comment, store: reloaded }).poll();
      expect(comment).toHaveBeenCalledTimes(1);
    });

    it('値が変わってまた読めなければ、もう一度コメントする', async () => {
      const dispatcher = makeDispatcher({ comment });
      events = [withBody('起動: あした')];
      await dispatcher.poll();
      events = [withBody('起動: あさって')];
      await dispatcher.poll();
      expect(comment).toHaveBeenCalledTimes(2);
      expect(comment.mock.calls[1][1]).toContain('あさって');
    });

    it('読めるようになったら記録を消す。また読めなくなったら、同じ値でもコメントする', async () => {
      const dispatcher = makeDispatcher({ comment, now: () => new Date('2026-11-01T00:00:00Z') });
      events = [withBody('起動: あした')];
      await dispatcher.poll();
      events = [withBody('起動: 2026-11-20')];
      await dispatcher.poll();
      events = [withBody('起動: あした')];
      await dispatcher.poll();
      expect(comment).toHaveBeenCalledTimes(2);
    });

    it('run-at と run-after は別々に 1 回ずつコメントする', async () => {
      events = [withBody('起動: あした\n待つ: 12')];
      const dispatcher = makeDispatcher({
        comment,
        getIssueState: async () => ({ state: 'OPEN', stateReason: '' }),
      });
      await dispatcher.poll();
      await dispatcher.poll();
      // run-at が読めないあいだは run-after まで進まないので、まず run-at の 1 回
      expect(comment).toHaveBeenCalledTimes(1);

      events = [withBody('起動: 2026-11-20\n待つ: 12')];
      await makeDispatcher({
        comment,
        store,
        now: () => new Date('2026-11-21T00:00:00Z'),
        getIssueState: async () => ({ state: 'OPEN', stateReason: '' }),
      }).poll();
      expect(comment).toHaveBeenCalledTimes(2);
      expect(comment.mock.calls[1][1]).toContain('12');
    });

    it('comment が失敗しても処理は続け、記録しないので次のポーリングでもう一度試す', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      comment.mockRejectedValueOnce(new Error('gh failed'));
      events = [withBody('起動: あした'), { ...makeEvent(2) }];
      const dispatcher = makeDispatcher({ comment });
      await dispatcher.poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1].id).toBe('o/a#2');
      await dispatcher.poll();
      expect(comment).toHaveBeenCalledTimes(2);
      await dispatcher.poll();
      expect(comment).toHaveBeenCalledTimes(2);
    });

    it('comment の失敗のログは、同じ値なら 1 回だけ。コメントの再試行は毎回する。値が変わればまた出す', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      comment.mockRejectedValue(new Error('gh failed'));
      events = [withBody('起動: あした')];
      const dispatcher = makeDispatcher({ comment });
      await dispatcher.poll();
      await dispatcher.poll();
      await dispatcher.poll();
      expect(comment).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledTimes(1);

      events = [withBody('起動: あさって')];
      await dispatcher.poll();
      expect(error).toHaveBeenCalledTimes(2);
    });

    it('値はコードスパンで囲み、バッククォートは除く（メンションが飛ばない）', async () => {
      events = [withBody('起動: @someone`x')];
      await makeDispatcher({ comment }).poll();
      const message = comment.mock.calls[0][1] as string;
      expect(message).toContain('`@someonex`');
      expect(message).not.toContain('「@someone');
      expect(message).not.toContain('@someone`x');
    });

    it('待つ issue の値もコードスパンで囲む', async () => {
      events = [withBody('待つ: @someone')];
      await makeDispatcher({ comment }).poll();
      expect(comment.mock.calls[0][1]).toContain('`@someone`');
    });

    describe('積んだ後の issue', () => {
      it.each(['queued', 'running', 'done'] as const)(
        '%s の issue には、読めない値でもコメントしない（警告と起動しない判定はそのまま）',
        async (status) => {
          const warn = vi.mocked(console.warn);
          const valid = withBody('起動: 2026-11-10');
          store.enqueue(valid);
          if (status !== 'queued') store.setRunning(valid, 'cc-a-issue1');
          if (status === 'running') alive.add('cc-a-issue1');
          if (status === 'done') store.setStatus(valid, 'done');
          events = [withBody('起動: あした')];
          await makeDispatcher({ comment }).poll();
          expect(comment).not.toHaveBeenCalled();
          expect(warn).toHaveBeenCalledTimes(1);
          expect(store.invalidSpecCommented(valid, 'runAt')).toBeUndefined();
        }
      );

      it('needs_info の issue にはコメントする', async () => {
        const valid = withBody('起動: 2026-11-10');
        store.enqueue(valid);
        store.setStatus(valid, 'needs_info');
        events = [withBody('起動: あした')];
        await makeDispatcher({ comment }).poll();
        expect(comment).toHaveBeenCalledTimes(1);
      });

      it('待つ issue の読めない値も、積んだ後の issue にはコメントしない', async () => {
        const valid = withBody('待つ: #9');
        store.enqueue(valid);
        events = [withBody('待つ: 12')];
        await makeDispatcher({ comment }).poll();
        expect(comment).not.toHaveBeenCalled();
      });
    });

    it('comment がなくても動く', async () => {
      events = [withBody('起動: あした')];
      await expect(makeDispatcher().poll()).resolves.toBeUndefined();
      expect(launch).not.toHaveBeenCalled();
    });
  });

  describe('作業を始められるかの判定', () => {
    it('始められないと判定したら起動せず、needs_info にして issue にコメントし、通知する', async () => {
      events = [makeEvent(1)];
      const comment = vi.fn().mockResolvedValue(undefined);
      const checkReadiness = vi.fn(async () => ({ notReady: true, missing: '目的' }));
      await makeDispatcher({ checkReadiness, comment }).poll();

      expect(launch).not.toHaveBeenCalled();
      expect(store.listByStatus('needs_info')).toHaveLength(1);
      expect(comment).toHaveBeenCalledWith(
        events[0],
        expect.stringContaining('足りないもの: 目的')
      );
      expect(messages()[0]).toContain('内容が足りないため起動しませんでした: o/a#1');
    });

    it('止めた issue の分は同時起動数に数えず、次の issue を起動する', async () => {
      events = [makeEvent(1), makeEvent(2)];
      const checkReadiness = vi.fn(async (event: AgentEvent) => ({
        notReady: event.id === 'o/a#1',
      }));
      await makeDispatcher({ checkReadiness }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1].id).toBe('o/a#2');
    });

    it('本文が書き足されたら、次のポーリングで判定し直して起動する', async () => {
      events = [makeEvent(1)];
      let ready = false;
      const checkReadiness = vi.fn(async () => ({ notReady: !ready }));
      const dispatcher = makeDispatcher({ checkReadiness });
      await dispatcher.poll();
      // 本文が変わらなければ判定し直さない
      await dispatcher.poll();
      expect(checkReadiness).toHaveBeenCalledTimes(1);

      ready = true;
      events = [{ ...makeEvent(1), body: '書き足した本文' }];
      await dispatcher.poll();
      expect(checkReadiness).toHaveBeenCalledTimes(2);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][0]).toContain('書き足した本文');
    });

    it('判定が例外を投げたら起動する。コメントが失敗しても通知はする', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      events = [makeEvent(1)];
      await makeDispatcher({
        checkReadiness: async () => {
          throw new Error('boom');
        },
      }).poll();
      expect(launch).toHaveBeenCalledTimes(1);

      events = [makeEvent(2)];
      alive.clear();
      await makeDispatcher({
        checkReadiness: async () => ({ notReady: true }),
        comment: async () => {
          throw new Error('gh failed');
        },
      }).poll();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(messages().at(-1)).toContain('足りないもの: 不明');
    });
  });

  describe('xangi の再起動', () => {
    it('セッションが残っていれば起動中のまま扱い、起動し直さない', async () => {
      const event = makeEvent(1);
      store.enqueue(event);
      store.setRunning(event, 'cc-a-issue1');
      alive.add('cc-a-issue1');
      events = [event, makeEvent(2)];

      const dispatcher = makeDispatcher({ store: new EventStore(join(dir, 'events.json')) });
      await dispatcher.start(60_000);
      dispatcher.stop();

      expect(launch).not.toHaveBeenCalled();
    });

    it('セッションがなければ終了にし、同じ issue は起動し直さない', async () => {
      const event = makeEvent(1);
      store.enqueue(event);
      store.setRunning(event, 'cc-a-issue1');
      events = [event];

      const reloaded = new EventStore(join(dir, 'events.json'));
      const dispatcher = makeDispatcher({ store: reloaded });
      await dispatcher.start(60_000);
      dispatcher.stop();

      expect(launch).not.toHaveBeenCalled();
      expect(reloaded.countByStatus('done')).toBe(1);
    });

    it('セッション名のない起動中の記録は interrupted にして通知し、再実行しない', async () => {
      const event = makeEvent(1);
      store.enqueue(event);
      store.setStatus(event, 'running');
      events = [event];

      const dispatcher = makeDispatcher();
      await dispatcher.start(60_000);
      dispatcher.stop();

      expect(launch).not.toHaveBeenCalled();
      expect(messages()[0]).toContain('⚠️');
      expect(store.countByStatus('interrupted')).toBe(1);
    });
  });
});

describe('buildEventPrompt', () => {
  it('issue の情報と、対応不要の場合の進め方を含める', () => {
    const prompt = buildEventPrompt(makeEvent(1));
    expect(prompt).toContain('o/a#1 issue 1');
    expect(prompt).toContain('https://github.com/o/a/issues/1');
    expect(prompt).toContain('body 1');
    expect(prompt).toContain('対応不要と判断したら');
  });

  it('長い本文は切り詰め、URL から読むよう書く', () => {
    const prompt = buildEventPrompt({ ...makeEvent(1), body: 'x'.repeat(5000) });
    expect(prompt).not.toContain('x'.repeat(4001));
    expect(prompt).toContain('全文は URL から読むこと');
  });
});

describe('isLoadAcceptable', () => {
  it('load average ÷ CPU コア数 が上限以下なら true', () => {
    expect(isLoadAcceptable(0.8, () => 6.4, 8)).toBe(true);
    expect(isLoadAcceptable(0.8, () => 6.5, 8)).toBe(false);
  });
});

describe('loadEventConfig', () => {
  it('既定は無効。ラベルは agent、間隔は 300 秒', () => {
    expect(loadEventConfig({})).toEqual({
      enabled: false,
      requested: false,
      githubRepos: [],
      githubLabel: 'agent',
      pollIntervalMs: 300_000,
      maxLoadPerCpu: 0.8,
      maxConcurrent: 5,
      notifyChannelId: undefined,
      claudePath: undefined,
      claudeSkipPermissions: true,
      wakeChannelId: undefined,
      runAtDigestChannelId: undefined,
    });
  });

  it('環境変数を読む', () => {
    expect(
      loadEventConfig({
        EVENTS_ENABLED: 'true',
        EVENT_GITHUB_REPOS: 'o/a, o/b',
        EVENT_GITHUB_LABEL: 'bot',
        EVENT_POLL_INTERVAL_SEC: '60',
        EVENT_MAX_LOAD: '1.5',
        EVENT_MAX_CONCURRENT: '2',
        EVENT_NOTIFY_CHANNEL_ID: '123',
        EVENT_CLAUDE_PATH: '/opt/bin/claude',
        EVENT_CLAUDE_SKIP_PERMISSIONS: 'false',
        EVENT_WAKE_CHANNEL_ID: ' C123 ',
        EVENT_RUN_AT_DIGEST_CHANNEL_ID: ' C456 ',
      })
    ).toEqual({
      enabled: true,
      requested: true,
      githubRepos: ['o/a', 'o/b'],
      githubLabel: 'bot',
      pollIntervalMs: 60_000,
      maxLoadPerCpu: 1.5,
      maxConcurrent: 2,
      notifyChannelId: '123',
      claudePath: '/opt/bin/claude',
      claudeSkipPermissions: false,
      wakeChannelId: 'C123',
      runAtDigestChannelId: 'C456',
    });
  });

  it('EVENT_CLAUDE_SKIP_PERMISSIONS は false / 0 / no / off を大文字小文字に関係なく付けないと読む', () => {
    for (const v of ['false', 'FALSE', ' 0 ', 'No', 'off']) {
      expect(loadEventConfig({ EVENT_CLAUDE_SKIP_PERMISSIONS: v }).claudeSkipPermissions).toBe(
        false
      );
    }
    for (const v of ['', 'true', '1', 'YES', 'on']) {
      expect(loadEventConfig({ EVENT_CLAUDE_SKIP_PERMISSIONS: v }).claudeSkipPermissions).toBe(
        true
      );
    }
  });

  it('EVENT_CLAUDE_SKIP_PERMISSIONS が知らない値なら警告して付ける', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEventConfig({ EVENT_CLAUDE_SKIP_PERMISSIONS: 'nope' }).claudeSkipPermissions).toBe(
      true
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_CLAUDE_SKIP_PERMISSIONS'));
    warn.mockRestore();
  });

  it('リポジトリが空なら有効にしないが、EVENTS_ENABLED で有効にしたことは残す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadEventConfig({ EVENTS_ENABLED: 'true' });
    expect(config.enabled).toBe(false);
    expect(config.requested).toBe(true);
    warn.mockRestore();
  });

  it('ウォッチリストがあれば、EVENT_GITHUB_REPOS が空でも有効にする', () => {
    expect(loadEventConfig({ EVENTS_ENABLED: 'true' }, true).enabled).toBe(true);
  });

  it('ウォッチリストと EVENT_GITHUB_REPOS の両方があれば、EVENT_GITHUB_REPOS を無視するとログに出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      loadEventConfig({ EVENTS_ENABLED: 'true', EVENT_GITHUB_REPOS: 'o/a' }, true).enabled
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_GITHUB_REPOS is ignored'));
    warn.mockRestore();
  });

  it('数値でない・0 以下の値は既定値にする', () => {
    const config = loadEventConfig({ EVENT_POLL_INTERVAL_SEC: 'abc', EVENT_MAX_CONCURRENT: '0' });
    expect(config.pollIntervalMs).toBe(300_000);
    expect(config.maxConcurrent).toBe(5);
  });
});

describe('EventDispatcher.wake', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'event-dispatcher-wake-'));
    store = new EventStore(join(dir, 'events.json'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDispatcher(poll: EventSource['poll']) {
    return new EventDispatcher({
      sources: [{ name: 'fake', poll }],
      store,
      launch: async (_prompt, event) => ({ sessionName: event.id, launched: true }),
      isAlive: async () => true,
      notify: async () => {},
      maxConcurrent: 1,
      isLoadAcceptable: () => true,
      wakeDelayMs: 1000,
    });
  }

  it('合図を受けたら、待ち時間のあとにポーリングし、イベントを起動する', async () => {
    const poll = vi.fn(async () => [makeEvent(1)]);
    const dispatcher = makeDispatcher(poll);

    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(store.listByStatus('running')).toHaveLength(1);
  });

  it('待ち時間の間に続いた合図は、1 回のポーリングにまとめる', async () => {
    const poll = vi.fn(async () => []);
    const dispatcher = makeDispatcher(poll);

    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(500);
    dispatcher.wake();
    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('ポーリング中に合図が来たら、終わったあとにもう 1 回ポーリングする', async () => {
    let release!: () => void;
    const poll = vi
      .fn<EventSource['poll']>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))))
      .mockResolvedValue([makeEvent(2)]);
    const dispatcher = makeDispatcher(poll);

    const first = dispatcher.poll();
    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(store.listByStatus('running').map((r) => r.event.id)).toEqual(['o/a#2']);
  });

  it('ポーリング中に合図がなければ、終わったあとにポーリングし直さない', async () => {
    const poll = vi.fn(async () => []);
    const dispatcher = makeDispatcher(poll);

    await dispatcher.poll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('ポーリング中に合図が来ても、stop したら終わったあとにポーリングし直さない', async () => {
    let release!: () => void;
    const poll = vi
      .fn<EventSource['poll']>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve([]))))
      .mockResolvedValue([]);
    const dispatcher = makeDispatcher(poll);

    const first = dispatcher.poll();
    dispatcher.wake();
    await vi.advanceTimersByTimeAsync(1000);
    dispatcher.stop();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('stop したら、待っている合図のポーリングもしない', async () => {
    const poll = vi.fn(async () => []);
    const dispatcher = makeDispatcher(poll);

    dispatcher.wake();
    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
  });
});
