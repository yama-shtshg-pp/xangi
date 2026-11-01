import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getJevToolRiskMode,
  judgeToolRisk,
  toolTarget,
  ToolRiskChecker,
  type ToolRiskInput,
  type ToolRiskJudgement,
} from '../src/tool-risk.js';

describe('getJevToolRiskMode', () => {
  it('未設定は off、shadow・on はそのまま、不明な値は off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getJevToolRiskMode({})).toBe('off');
    expect(getJevToolRiskMode({ JEV_TOOL_RISK: 'shadow' })).toBe('shadow');
    expect(getJevToolRiskMode({ JEV_TOOL_RISK: ' On ' })).toBe('on');
    expect(getJevToolRiskMode({ JEV_TOOL_RISK: 'true' })).toBe('off');
    vi.restoreAllMocks();
  });
});

describe('toolTarget', () => {
  it('Bash はコマンド、Write・Edit はファイルのパス', () => {
    expect(toolTarget('Bash', { command: 'ls' })).toBe('ls');
    expect(toolTarget('Edit', { file_path: '/a.ts', old_string: 'x' })).toBe('/a.ts');
    expect(toolTarget('Write', {})).toBe('');
  });
});

describe('judgeToolRisk', () => {
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

  it('ツール・対象・issue を state に入れ、破壊的か・外部に触れるかを 1 回で聞く', async () => {
    respond({ destructive: { noul: 0.9 }, external: { noul: 0.8 } });
    const res = await judgeToolRisk('Bash', 'kubectl delete ns prod', 'クラスタの掃除');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state).toEqual({
      tool: 'Bash',
      target: 'kubectl delete ns prod',
      issue: 'クラスタの掃除',
    });
    expect(Object.keys(sent.questions)).toEqual(['destructive', 'external']);
    expect(res).toMatchObject({ ok: true, destructive: 0.9, external: 0.8, jevModel: 'jev-1' });
  });

  it('答えが欠けていれば ok: false', async () => {
    respond({ destructive: { noul: 0.9 } });
    expect((await judgeToolRisk('Bash', 'x', '')).ok).toBe(false);
  });
});

describe('ToolRiskChecker', () => {
  let dir: string;
  let logPath: string;
  const bash = (command: string): ToolRiskInput => ({
    session: 'cc-a-issue1',
    issueId: 'o/a#1',
    issueTitle: 'タイトル',
    toolName: 'Bash',
    toolInput: { command },
  });
  const risky: ToolRiskJudgement = { ok: true, destructive: 0.9, external: 0.2, latencyMs: 5 };
  const safe: ToolRiskJudgement = { ok: true, destructive: 0.1, external: 0.1, latencyMs: 5 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-risk-'));
    logPath = join(dir, 'logs', 'jev-tool-risk.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLog = () =>
    readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  it('off では判定もログもしない', async () => {
    const judge = vi.fn(async () => risky);
    const checker = new ToolRiskChecker({ mode: 'off', logPath, judge });
    expect(await checker.check(bash('rm -rf /'))).toEqual({ decision: 'allow', reasons: [] });
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('shadow では危なくても許可し、判定をログに残す', async () => {
    const judge = vi.fn(async () => risky);
    const checker = new ToolRiskChecker({ mode: 'shadow', logPath, judge });
    expect(await checker.check(bash('kubectl delete ns prod'))).toEqual({
      decision: 'allow',
      reasons: [],
    });
    await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
    expect(readLog()[0]).toMatchObject({
      mode: 'shadow',
      session: 'cc-a-issue1',
      issue: 'o/a#1',
      tool: 'Bash',
      target: 'kubectl delete ns prod',
      pattern: null,
      destructive: 0.9,
      risky: true,
    });
  });

  it('on でパターンに一致したら、Jev に聞かずに ask を返す', async () => {
    const judge = vi.fn(async () => safe);
    const checker = new ToolRiskChecker({ mode: 'on', logPath, judge });
    const verdict = await checker.check(bash('git push origin main'));
    expect(verdict).toEqual({ decision: 'ask', reasons: ['Git push'] });
    expect(judge).not.toHaveBeenCalled();
    expect(readLog()[0]).toMatchObject({ pattern: ['Git push'], destructive: null, risky: true });
  });

  it('on でパターンに一致せず、Jev が危ないと判定したら ask を返す', async () => {
    const checker = new ToolRiskChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ...risky, external: 0.7 }),
    });
    expect(await checker.check(bash('terraform destroy'))).toEqual({
      decision: 'ask',
      reasons: ['破壊的な操作（Jev の判定）', '本番や外部のサービスに触れる操作（Jev の判定）'],
    });
  });

  it('on でも、Jev が安全と判定したら許可する', async () => {
    const checker = new ToolRiskChecker({ mode: 'on', logPath, judge: async () => safe });
    expect((await checker.check(bash('npm test'))).decision).toBe('allow');
  });

  it('on で Jev が失敗・例外を投げたら、パターンに一致しなければ許可し、理由をログに残す', async () => {
    const failing = new ToolRiskChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ok: false, error: 'timeout', latencyMs: 800 }),
    });
    expect((await failing.check(bash('terraform destroy'))).decision).toBe('allow');
    const throwing = new ToolRiskChecker({
      mode: 'on',
      logPath,
      judge: async () => {
        throw new Error('boom');
      },
    });
    expect((await throwing.check(bash('terraform destroy'))).decision).toBe('allow');
    expect(readLog().map((r) => r.error)).toEqual(['timeout', 'boom']);
  });

  it('ログにはコマンドの先頭だけを残す', async () => {
    const checker = new ToolRiskChecker({ mode: 'on', logPath, judge: async () => safe });
    await checker.check(bash(`echo ${'x'.repeat(500)}`));
    const record = readLog()[0];
    expect(record.target.length).toBe(100);
    expect(record.target_length).toBe(505);
  });
});
