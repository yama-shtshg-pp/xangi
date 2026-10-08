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

  it('同じ名前のセッションがすでにあれば起動せず、閉じられるまで起動中として数える', async () => {
    events = [makeEvent(1), makeEvent(2)];
    alive.add('cc-a-issue1');
    launch.mockImplementationOnce(async () => ({ sessionName: 'cc-a-issue1', launched: false }));
    const dispatcher = makeDispatcher();

    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.listByStatus('running')[0].sessionName).toBe('cc-a-issue1');
    expect(messages()[0]).toContain('⚠️ 同じ名前の tmux セッション cc-a-issue1');

    alive.delete('cc-a-issue1');
    await dispatcher.poll();
    expect(launch).toHaveBeenCalledTimes(2);
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
      githubRepos: [],
      githubLabel: 'agent',
      pollIntervalMs: 300_000,
      maxLoadPerCpu: 0.8,
      maxConcurrent: 1,
      notifyChannelId: undefined,
      claudePath: undefined,
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
      })
    ).toEqual({
      enabled: true,
      githubRepos: ['o/a', 'o/b'],
      githubLabel: 'bot',
      pollIntervalMs: 60_000,
      maxLoadPerCpu: 1.5,
      maxConcurrent: 2,
      notifyChannelId: '123',
      claudePath: '/opt/bin/claude',
    });
  });

  it('リポジトリが空なら有効にしない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEventConfig({ EVENTS_ENABLED: 'true' }).enabled).toBe(false);
    warn.mockRestore();
  });

  it('数値でない・0 以下の値は既定値にする', () => {
    const config = loadEventConfig({ EVENT_POLL_INTERVAL_SEC: 'abc', EVENT_MAX_CONCURRENT: '0' });
    expect(config.pollIntervalMs).toBe(300_000);
    expect(config.maxConcurrent).toBe(1);
  });
});
