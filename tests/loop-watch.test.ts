import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getJevLoopWatchMode,
  judgeLoopState,
  LoopWatcher,
  type LoopState,
  type LoopStateInput,
  type JudgeLoopState,
  type LoopWatchAlert,
} from '../src/loop-watch.js';

describe('getJevLoopWatchMode', () => {
  it('未設定は off、shadow・on はそのまま、不明な値は off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getJevLoopWatchMode({})).toBe('off');
    expect(getJevLoopWatchMode({ JEV_LOOP_WATCH: 'shadow' })).toBe('shadow');
    expect(getJevLoopWatchMode({ JEV_LOOP_WATCH: ' On ' })).toBe('on');
    expect(getJevLoopWatchMode({ JEV_LOOP_WATCH: 'true' })).toBe('off');
    vi.restoreAllMocks();
  });
});

describe('judgeLoopState', () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  const input: LoopStateInput = { issueTitle: 'タイトル', lastMessage: '終わりました', turn: 3 };

  it('Choice で聞き、選んだ状態と確率を返す', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'jev-1',
        answers: {
          state: {
            type: 'choice',
            choice: 'done',
            probabilities: { done: 0.8, continue: 0.1, stuck: 0.05, ask_human: 0.05 },
          },
        },
      }),
    });
    const result = await judgeLoopState(input);
    expect(result).toMatchObject({ ok: true, state: 'done', jevModel: 'jev-1' });
    expect(result.probabilities?.done).toBe(0.8);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.state).toEqual({
      issue: 'タイトル',
      last_message: '終わりました',
      turn: 3,
      previous_state: 'none',
    });
    expect(body.questions.state.type).toBe('choice');
    expect(Object.keys(body.questions.state.criteria)).toEqual([
      'done',
      'continue',
      'stuck',
      'ask_human',
    ]);
  });

  it('返答は末尾の 2000 文字だけを渡し、前回の判定を入れる', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { state: { type: 'choice', choice: 'stuck' } } }),
    });
    const long = 'a'.repeat(3000) + 'END';
    await judgeLoopState({ ...input, lastMessage: long, previous: 'stuck' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.state.last_message).toBe(`…${long.slice(-2000)}`);
    expect(body.state.previous_state).toBe('stuck');
  });

  it('API の失敗と想定外の選択肢は ok: false', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await judgeLoopState(input)).toMatchObject({ ok: false, error: 'HTTP 500' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ answers: { state: { type: 'choice', choice: 'other' } } }),
    });
    expect((await judgeLoopState(input)).error).toMatch(/unexpected answer/);
  });

  it('タイムアウトは ok: false で error: timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    expect(await judgeLoopState(input, 10)).toMatchObject({ ok: false, error: 'timeout' });
  });
});

describe('LoopWatcher', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-watch-'));
    logPath = join(dir, 'logs', 'jev-loop-watch.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const readLog = () =>
    readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  /** 順に状態を返す判定（undefined なら失敗） */
  function judgeSeq(states: (LoopState | undefined)[]) {
    return vi.fn<JudgeLoopState>(async () => {
      const state = states.shift();
      return state
        ? { ok: true, state, probabilities: { [state]: 0.9 }, latencyMs: 12, jevModel: 'jev-1' }
        : { ok: false, latencyMs: 1500, error: 'timeout' };
    });
  }

  function watcher(mode: 'off' | 'shadow' | 'on', states: (LoopState | undefined)[]) {
    const judge = judgeSeq(states);
    const notify = vi.fn<(alert: LoopWatchAlert) => Promise<void>>(async () => {});
    return { judge, notify, watcher: new LoopWatcher({ mode, logPath, judge, notify }) };
  }

  const stop = (w: LoopWatcher, message = '返答', session = 'cc-a-issue1') =>
    w.handleStop({ session, issueId: 'o/a#1', issueTitle: 'タイトル', lastMessage: message });

  it('off では判定もログもしない', async () => {
    const { judge, watcher: w } = watcher('off', ['ask_human']);
    await stop(w);
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('shadow ではログに残すだけで知らせない。何回目かと前回の判定を渡す', async () => {
    const { judge, notify, watcher: w } = watcher('shadow', ['continue', 'ask_human']);
    await stop(w, 'x'.repeat(150) + 'secret-tail');
    await stop(w, 'どちらにしますか');
    expect(notify).not.toHaveBeenCalled();
    expect(judge.mock.calls[0][0]).toMatchObject({ turn: 1, previous: undefined });
    expect(judge.mock.calls[1][0]).toMatchObject({ turn: 2, previous: 'continue' });

    const [first, second] = readLog();
    expect(first).toMatchObject({
      mode: 'shadow',
      session: 'cc-a-issue1',
      issue: 'o/a#1',
      turn: 1,
      state: 'continue',
      probabilities: { continue: 0.9 },
      previous: null,
      message_length: 161,
      alert: null,
      latency_ms: 12,
      error: null,
    });
    // 返答は先頭と末尾の 100 文字だけを残す
    expect(first.message_head).toBe('x'.repeat(100));
    expect(first.message_tail).toBe(('x'.repeat(150) + 'secret-tail').slice(-100));
    // on なら知らせたことは、shadow でもログでわかる
    expect(second).toMatchObject({ state: 'ask_human', previous: 'continue', alert: 'ask_human' });
  });

  it('on では ask_human で返答の末尾を添えて知らせ、状態が変わるまで繰り返さない', async () => {
    const { notify, watcher: w } = watcher('on', [
      'ask_human',
      'ask_human',
      'continue',
      'ask_human',
    ]);
    await stop(w, 'A と B のどちらにしますか');
    await stop(w);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      session: 'cc-a-issue1',
      issueId: 'o/a#1',
      issueTitle: 'タイトル',
      state: 'ask_human',
      messageTail: 'A と B のどちらにしますか',
    });
    await stop(w);
    await stop(w);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('on では stuck が続けて 2 回出たら知らせ、3 回目は知らせない', async () => {
    const { notify, watcher: w } = watcher('on', ['stuck', 'continue', 'stuck', 'stuck', 'stuck']);
    await stop(w);
    await stop(w);
    await stop(w);
    expect(notify).not.toHaveBeenCalled();
    await stop(w);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].state).toBe('stuck');
    await stop(w);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('セッションごとに数える', async () => {
    const { notify, watcher: w } = watcher('on', ['stuck', 'stuck']);
    await stop(w, '返答', 'cc-a-issue1');
    await stop(w, '返答', 'cc-a-issue2');
    expect(notify).not.toHaveBeenCalled();
    expect(readLog().map((r) => r.turn)).toEqual([1, 1]);
  });

  it('Jev の失敗はログに error を残すだけで、前回の判定と stuck の回数を変えない', async () => {
    const { judge, notify, watcher: w } = watcher('on', ['stuck', undefined, 'stuck']);
    await stop(w);
    await stop(w);
    expect(readLog()[1]).toMatchObject({ state: null, error: 'timeout', turn: 2, alert: null });
    await stop(w);
    expect(judge.mock.calls[2][0]).toMatchObject({ turn: 3, previous: 'stuck' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('判定が例外を投げても、通知が失敗しても外に出さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const judge = vi.fn(async () => {
      throw new Error('boom');
    });
    const w = new LoopWatcher({ mode: 'on', logPath, judge });
    await expect(stop(w)).resolves.toBeUndefined();
    expect(readLog()[0].error).toBe('boom');

    const failing = new LoopWatcher({
      mode: 'on',
      logPath,
      judge: judgeSeq(['ask_human']),
      notify: async () => {
        throw new Error('send failed');
      },
    });
    await expect(stop(failing)).resolves.toBeUndefined();
  });

  it('返答の本文がなければ Jev に聞かず、error を残す', async () => {
    const { judge, watcher: w } = watcher('shadow', ['done']);
    await w.handleStop({ session: 'cc-a-issue1' });
    expect(judge).not.toHaveBeenCalled();
    expect(readLog()[0]).toMatchObject({ error: 'no last_assistant_message', issue: null });
  });

  it('同じセッションの判定は順に処理する', async () => {
    const { judge, watcher: w } = watcher('shadow', ['stuck', 'continue']);
    await Promise.all([stop(w, '1'), stop(w, '2')]);
    expect(judge.mock.calls[1][0]).toMatchObject({ turn: 2, previous: 'stuck', lastMessage: '2' });
  });
});
