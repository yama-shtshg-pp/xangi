import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import type { Config } from '../src/config.js';
import type { BackendResolver } from '../src/backend-resolver.js';

const defaultRun = vi.fn();
const adhocRun = vi.fn();

vi.mock('../src/agent-runner.js', () => ({
  createAgentRunner: () => ({ run: defaultRun, runStream: vi.fn() }),
  getBackendDisplayName: (b: string) => b,
}));
vi.mock('../src/claude-code.js', () => ({
  ClaudeCodeRunner: class {
    run = adhocRun;
    runStream = vi.fn();
  },
}));
vi.mock('../src/runner-manager.js', () => ({ RunnerManager: class {} }));
vi.mock('../src/sessions.js', () => ({ deleteSession: vi.fn() }));
vi.mock('../src/jev-client.js', () => ({ appendJevLog: vi.fn() }));
vi.mock('../src/router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/router.js')>()),
  routeWithJev: vi.fn(),
}));

const { DynamicRunnerManager } = await import('../src/dynamic-runner.js');
const { routeWithJev } = await import('../src/router.js');
const { appendJevLog } = await import('../src/jev-client.js');
const routeWithJevMock = vi.mocked(routeWithJev);
const appendJevLogMock = vi.mocked(appendJevLog);

const config = {
  agent: {
    backend: 'claude-code',
    config: { model: 'haiku', workdir: '/tmp/xangi-test' },
    platform: 'discord',
  },
} as unknown as Config;

const resolver = {
  resolve: () => ({ backend: 'claude-code' }),
  getDefault: () => ({ backend: 'claude-code' }),
  isModelAllowed: () => true,
} as unknown as BackendResolver;

/** fire-and-forget の then チェーンを流しきる */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('DynamicRunnerManager の Jev shadow ルーティング', () => {
  const originalMode = process.env.JEV_ROUTING;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.DATA_DIR;
    defaultRun.mockReset().mockResolvedValue({ result: 'default answer', sessionId: 's1' });
    adhocRun.mockReset().mockResolvedValue({ result: 'opus answer', sessionId: 'adhoc' });
    routeWithJevMock.mockReset().mockResolvedValue({
      ok: true,
      effort: 'light',
      model: 'haiku',
      confidence: 0.7,
      latencyMs: 100,
      jevModel: 'jev-1.13.0',
    });
    appendJevLogMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMode === undefined) delete process.env.JEV_ROUTING;
    else process.env.JEV_ROUTING = originalMode;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('JEV_ROUTING 未設定なら Jev を呼ばない', async () => {
    delete process.env.JEV_ROUTING;
    const manager = new DynamicRunnerManager(config, resolver);
    await manager.run('こんにちは', { channelId: 'ch1' });
    await flush();
    expect(routeWithJevMock).not.toHaveBeenCalled();
  });

  it('shadow: Jev の結果をログに残し、振り分けは regex のまま', async () => {
    process.env.JEV_ROUTING = 'shadow';
    const manager = new DynamicRunnerManager(config, resolver);
    const res = await manager.run('こんにちは', { channelId: 'ch1' });
    await flush();

    expect(res.result).toBe('default answer');
    expect(adhocRun).not.toHaveBeenCalled();
    expect(routeWithJevMock).toHaveBeenCalledWith('こんにちは', undefined);
    expect(appendJevLogMock).toHaveBeenCalledWith(
      join('/tmp/xangi-test', '.xangi', 'logs', 'jev-routing.jsonl'),
      expect.objectContaining({
        channel: 'ch1',
        prompt: 'こんにちは',
        regex: 'default',
        default_model: 'haiku',
        jev: 'haiku',
        jev_effort: 'light',
        confidence: 0.7,
        has_previous: false,
        latency_ms: 100,
        error: null,
      })
    );
  });

  it('shadow: Jev の応答を待たずに本流の処理を返す', async () => {
    process.env.JEV_ROUTING = 'shadow';
    routeWithJevMock.mockReturnValue(new Promise(() => {}));
    const manager = new DynamicRunnerManager(config, resolver);
    await expect(manager.run('こんにちは', { channelId: 'ch1' })).resolves.toMatchObject({
      result: 'default answer',
    });
  });

  it('shadow: Opus の回答直後のメッセージだけ、直前のやり取りを渡して追問判定する', async () => {
    process.env.JEV_ROUTING = 'shadow';
    const manager = new DynamicRunnerManager(config, resolver);

    await manager.run('Error: foo is not defined', { channelId: 'ch1' });
    expect(adhocRun).toHaveBeenCalledTimes(1);
    expect(routeWithJevMock).toHaveBeenLastCalledWith('Error: foo is not defined', undefined);

    await manager.run('もっと詳しく', { channelId: 'ch1' });
    expect(routeWithJevMock).toHaveBeenLastCalledWith('もっと詳しく', {
      userMessage: 'Error: foo is not defined',
      assistantAnswer: 'opus answer',
    });

    // Opus を挟まなければ直前のやり取りは渡さない
    await manager.run('次の話', { channelId: 'ch1' });
    expect(routeWithJevMock).toHaveBeenLastCalledWith('次の話', undefined);
  });

  it('shadow: 直前のやり取りはチャンネルごとに分ける', async () => {
    process.env.JEV_ROUTING = 'shadow';
    const manager = new DynamicRunnerManager(config, resolver);
    await manager.run('Error: foo', { channelId: 'ch1' });
    await manager.run('もっと詳しく', { channelId: 'ch2' });
    expect(routeWithJevMock).toHaveBeenLastCalledWith('もっと詳しく', undefined);
  });

  it('shadow: 直前のやり取りは 30 分で期限切れになる', async () => {
    process.env.JEV_ROUTING = 'shadow';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const manager = new DynamicRunnerManager(config, resolver);
      await manager.run('Error: foo', { channelId: 'ch1' });
      vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
      await manager.run('もっと詳しく', { channelId: 'ch1' });
      expect(routeWithJevMock).toHaveBeenLastCalledWith('もっと詳しく', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shadow: Opus の回答が空なら直前のやり取りとして覚えない', async () => {
    process.env.JEV_ROUTING = 'shadow';
    adhocRun.mockResolvedValue({ result: '', sessionId: 'adhoc' });
    const manager = new DynamicRunnerManager(config, resolver);
    await manager.run('Error: foo', { channelId: 'ch1' });
    await manager.run('もっと詳しく', { channelId: 'ch1' });
    expect(routeWithJevMock).toHaveBeenLastCalledWith('もっと詳しく', undefined);
  });

  it('shadow: チャンネルが opus 固定なら Jev を呼ばない（regex の振り分け対象外）', async () => {
    process.env.JEV_ROUTING = 'shadow';
    const opusConfig = {
      ...config,
      agent: { ...config.agent, config: { ...config.agent.config, model: 'opus' } },
    } as Config;
    const manager = new DynamicRunnerManager(opusConfig, resolver);
    await manager.run('こんにちは', { channelId: 'ch1' });
    expect(routeWithJevMock).not.toHaveBeenCalled();
  });

  it('shadow: skipRouting のときは Jev も呼ばない', async () => {
    process.env.JEV_ROUTING = 'shadow';
    const manager = new DynamicRunnerManager(config, resolver);
    await manager.run('Error: foo', { channelId: 'ch1', skipRouting: true });
    expect(routeWithJevMock).not.toHaveBeenCalled();
  });
});
