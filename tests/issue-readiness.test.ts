import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getJevReadinessMode,
  IssueReadinessChecker,
  judgeIssueReadiness,
  MISSING_LABELS,
  type IssueReadiness,
  type ReadinessInput,
} from '../src/issue-readiness.js';
import { JEV_ENDPOINT } from '../src/jev-client.js';

describe('getJevReadinessMode', () => {
  it('未設定は off、shadow・on はそのまま、不明な値は off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getJevReadinessMode({})).toBe('off');
    expect(getJevReadinessMode({ JEV_READINESS: 'shadow' })).toBe('shadow');
    expect(getJevReadinessMode({ JEV_READINESS: ' ON ' })).toBe('on');
    expect(getJevReadinessMode({ JEV_READINESS: 'yes' })).toBe('off');
    vi.restoreAllMocks();
  });
});

describe('judgeIssueReadiness', () => {
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

  function respond(answers: Record<string, unknown>) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: 'jev-1', answers }), { status: 200 })
    );
  }

  it('タイトルと本文を state に入れ、始められるかと足りないものを 1 回で聞く', async () => {
    respond({
      ready: { type: 'noul', noul: 0.2 },
      missing: { type: 'choice', choice: 'done', probabilities: { done: 0.7 } },
    });
    const res = await judgeIssueReadiness('チェック', '');
    expect(fetchMock).toHaveBeenCalledWith(JEV_ENDPOINT, expect.anything());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state).toEqual({ title: 'チェック', body: '（本文なし）' });
    expect(Object.keys(sent.questions)).toEqual(['ready', 'missing']);
    expect(res).toMatchObject({ ok: true, ready: 0.2, missing: 'done', jevModel: 'jev-1' });
  });

  it('長い本文は切り詰めて送る', async () => {
    respond({ ready: { type: 'noul', noul: 0.9 } });
    await judgeIssueReadiness('t', 'x'.repeat(10_000));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state.body.length).toBeLessThan(5000);
  });

  it('ready の答えがなければ ok: false、知らない選択肢は missing にしない', async () => {
    respond({ missing: { type: 'choice', choice: 'done' } });
    expect((await judgeIssueReadiness('t', 'b')).ok).toBe(false);
    respond({ ready: { type: 'noul', noul: 0.1 }, missing: { type: 'choice', choice: 'other' } });
    const res = await judgeIssueReadiness('t', 'b');
    expect(res.ok).toBe(true);
    expect(res.missing).toBeUndefined();
  });

  it('キー未設定なら ok: false', async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(await judgeIssueReadiness('t', 'b')).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('IssueReadinessChecker', () => {
  let dir: string;
  let logPath: string;
  const input: ReadinessInput = {
    source: 'github',
    repo: 'o/a',
    id: 'o/a#1',
    title: 'チェック',
    body: '',
  };
  const notReady: IssueReadiness = { ok: true, ready: 0.1, missing: 'purpose', latencyMs: 5 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-readiness-'));
    logPath = join(dir, 'logs', 'jev-readiness.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLog = () =>
    readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  it('off では Jev を呼ばず、ログも残さない', async () => {
    const judge = vi.fn(async () => notReady);
    const checker = new IssueReadinessChecker({ mode: 'off', logPath, judge });
    expect(await checker.check(input)).toEqual({ notReady: false });
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('shadow では始められなくても止めず、判定をログに残す', async () => {
    const judge = vi.fn(async () => notReady);
    const checker = new IssueReadinessChecker({ mode: 'shadow', logPath, judge });
    expect(await checker.check(input)).toEqual({ notReady: false });
    await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
    expect(readLog()[0]).toMatchObject({
      mode: 'shadow',
      source: 'github',
      repo: 'o/a',
      id: 'o/a#1',
      ready: 0.1,
      not_ready: true,
      missing: 'purpose',
      latency_ms: 5,
      error: null,
    });
  });

  it('shadow では判定を待たずに返す', async () => {
    let resolve!: (r: IssueReadiness) => void;
    const judge = vi.fn(() => new Promise<IssueReadiness>((r) => (resolve = r)));
    const checker = new IssueReadinessChecker({ mode: 'shadow', logPath, judge });
    expect(await checker.check(input)).toEqual({ notReady: false });
    resolve(notReady);
    await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
  });

  it('on で始められないと判定したら、足りないものを言葉で返す', async () => {
    const checker = new IssueReadinessChecker({ mode: 'on', logPath, judge: async () => notReady });
    expect(await checker.check(input)).toEqual({
      notReady: true,
      missing: MISSING_LABELS.purpose,
    });
    expect(readLog()[0]).toMatchObject({ mode: 'on', not_ready: true });
  });

  it('on でも、しきい値以上なら止めない', async () => {
    const checker = new IssueReadinessChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ok: true, ready: 0.8, missing: 'done', latencyMs: 1 }),
    });
    expect(await checker.check(input)).toEqual({ notReady: false });
  });

  it('on で Jev が失敗・例外を投げたら、止めずに理由をログに残す', async () => {
    const failing = new IssueReadinessChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ok: false, error: 'timeout', latencyMs: 800 }),
    });
    expect(await failing.check(input)).toEqual({ notReady: false });
    const throwing = new IssueReadinessChecker({
      mode: 'on',
      logPath,
      judge: async () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.check(input)).toEqual({ notReady: false });
    expect(readLog().map((r) => r.error)).toEqual(['timeout', 'boom']);
  });
});
