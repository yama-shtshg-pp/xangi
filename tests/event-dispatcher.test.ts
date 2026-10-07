import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EventDispatcher,
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

/** 外から解決できる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('EventDispatcher', () => {
  let dir: string;
  let store: EventStore;
  let events: AgentEvent[];
  let source: EventSource;
  let notify: ReturnType<typeof vi.fn>;
  let loadOk: boolean;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'event-dispatcher-'));
    store = new EventStore(join(dir, 'events.json'));
    events = [];
    source = { name: 'fake', poll: vi.fn(async () => events) };
    notify = vi.fn().mockResolvedValue(undefined);
    loadOk = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDispatcher(run: (prompt: string, event: AgentEvent) => Promise<string>) {
    return new EventDispatcher({
      sources: [source],
      store,
      run,
      notify,
      maxConcurrent: 1,
      isLoadAcceptable: () => loadOk,
    });
  }

  it('新しいイベントで起動し、完了を通知する', async () => {
    events = [makeEvent(1)];
    const run = vi.fn().mockResolvedValue('コメントしました');
    const dispatcher = makeDispatcher(run);

    await dispatcher.poll();
    await flush();

    expect(run).toHaveBeenCalledWith(buildEventPrompt(makeEvent(1)), makeEvent(1));
    expect(store.countByStatus('done')).toBe(1);
    const messages = notify.mock.calls.map((c) => c[0] as string);
    expect(messages[0]).toContain('🚀 起動します: o/a#1');
    expect(messages[1]).toContain('✅ 完了: o/a#1');
    expect(messages[1]).toContain('コメントしました');
  });

  it('同じイベントがポーリングで何度返っても 1 回しか起動しない', async () => {
    events = [makeEvent(1)];
    const run = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(run);

    await dispatcher.poll();
    await flush();
    await dispatcher.poll();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('同時起動数を超えたら、前のイベントが終わってから古い順に起動する', async () => {
    events = [makeEvent(1), makeEvent(2)];
    const first = deferred<string>();
    const run = vi.fn((_prompt: string, event: AgentEvent) =>
      event.id === 'o/a#1' ? first.promise : Promise.resolve('ok')
    );
    const dispatcher = makeDispatcher(run);

    await dispatcher.poll();
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.countByStatus('queued')).toBe(1);

    first.resolve('ok');
    await flush();
    await flush();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1].id).toBe('o/a#2');
  });

  it('負荷が高い間は起動せず 1 回だけ通知し、下がったら次のポーリングで起動する', async () => {
    events = [makeEvent(1)];
    loadOk = false;
    const run = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(run);

    await dispatcher.poll();
    await dispatcher.poll();
    expect(run).not.toHaveBeenCalled();
    const deferMessages = notify.mock.calls.filter((c) => (c[0] as string).startsWith('⏳'));
    expect(deferMessages).toHaveLength(1);
    expect(deferMessages[0][0]).toContain('1 件');

    loadOk = true;
    await dispatcher.poll();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('起動に失敗したら failed にして通知し、次のイベントに進む', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1), makeEvent(2)];
    const run = vi.fn(async (_prompt: string, event: AgentEvent) => {
      if (event.id === 'o/a#1') throw new Error('Process exited unexpectedly');
      return 'ok';
    });
    const dispatcher = makeDispatcher(run);

    await dispatcher.poll();
    await flush();
    await flush();

    expect(store.countByStatus('failed')).toBe(1);
    expect(store.countByStatus('done')).toBe(1);
    expect(notify.mock.calls.some((c) => (c[0] as string).includes('❌ 失敗: o/a#1'))).toBe(true);
  });

  it('通知に失敗しても起動は続ける', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1)];
    notify.mockRejectedValue(new Error('Missing Access'));
    const run = vi.fn().mockResolvedValue('ok');

    await makeDispatcher(run).poll();
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.countByStatus('done')).toBe(1);
  });

  it('イベント源の失敗でポーリング全体を止めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: EventSource = {
      name: 'broken',
      poll: vi.fn().mockRejectedValue(new Error('down')),
    };
    events = [makeEvent(1)];
    const run = vi.fn().mockResolvedValue('ok');
    const dispatcher = new EventDispatcher({
      sources: [broken, source],
      store,
      run,
      notify,
      maxConcurrent: 1,
      isLoadAcceptable: () => true,
    });

    await dispatcher.poll();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
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
    const dispatcher = makeDispatcher(vi.fn());
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

  it('完了の後処理で失敗しても failed に書き換えない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    events = [makeEvent(1)];
    const run = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(run);
    const setStatus = store.setStatus.bind(store);
    vi.spyOn(store, 'setStatus').mockImplementation((event, status, err) => {
      setStatus(event, status, err);
      if (status === 'done') throw new Error('disk full');
    });

    await dispatcher.poll();
    await flush();

    expect(store.countByStatus('done')).toBe(1);
    expect(store.countByStatus('failed')).toBe(0);
  });

  it('同時起動数が 2 なら 2 件まで並行して起動する', async () => {
    events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = vi.fn(
      (_prompt: string, event: AgentEvent) => pending[Number(event.id.split('#')[1]) - 1].promise
    );
    const dispatcher = new EventDispatcher({
      sources: [source],
      store,
      run,
      notify,
      maxConcurrent: 2,
      isLoadAcceptable: () => true,
    });

    await dispatcher.poll();
    expect(run).toHaveBeenCalledTimes(2);

    pending[0].resolve('ok');
    await flush();
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
    expect(store.countByStatus('running')).toBe(2);
  });

  it('start: 前回起動中だったイベントを通知し、再実行しない', async () => {
    const event = makeEvent(1);
    store.enqueue(event);
    store.setStatus(event, 'running');
    events = [event];
    const run = vi.fn().mockResolvedValue('ok');
    const dispatcher = makeDispatcher(run);

    await dispatcher.start(60_000);
    dispatcher.stop();
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain('⚠️');
    expect(store.countByStatus('interrupted')).toBe(1);
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
      })
    ).toEqual({
      enabled: true,
      githubRepos: ['o/a', 'o/b'],
      githubLabel: 'bot',
      pollIntervalMs: 60_000,
      maxLoadPerCpu: 1.5,
      maxConcurrent: 2,
      notifyChannelId: '123',
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
