import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  buildHookResponse,
  getToolRiskPort,
  startToolRiskServer,
  toolRiskHookUrl,
  DEFAULT_TOOL_RISK_PORT,
} from '../src/tool-risk-server.js';
import type { ToolRiskChecker, ToolRiskVerdict } from '../src/tool-risk.js';

describe('toolRiskHookUrl / getToolRiskPort', () => {
  it('セッション名をクエリに入れた URL を作る', () => {
    expect(toolRiskHookUrl(18190, 'cc-a-issue1')).toBe(
      'http://127.0.0.1:18190/hooks/tool-risk?session=cc-a-issue1'
    );
  });

  it('EVENT_TOOL_RISK_PORT を読み、不正な値なら既定のポート', () => {
    expect(getToolRiskPort({ EVENT_TOOL_RISK_PORT: '18195' })).toBe(18195);
    expect(getToolRiskPort({ EVENT_TOOL_RISK_PORT: 'abc' })).toBe(DEFAULT_TOOL_RISK_PORT);
    expect(getToolRiskPort({})).toBe(DEFAULT_TOOL_RISK_PORT);
  });
});

describe('buildHookResponse', () => {
  it('許可なら空、ask なら理由付きの ask を返す', () => {
    expect(buildHookResponse({ decision: 'allow', reasons: [] })).toBe('{}');
    expect(JSON.parse(buildHookResponse({ decision: 'ask', reasons: ['Git push', 'x'] }))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'xangi: Git push、x',
      },
    });
  });
});

describe('startToolRiskServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(
    check: (input: unknown) => Promise<ToolRiskVerdict>,
    onAsk = vi.fn(async () => {})
  ) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const checker = { check: vi.fn(check) } as unknown as ToolRiskChecker;
    server = startToolRiskServer({
      checker,
      port: 0,
      resolveSession: (session) =>
        session === 'cc-a-issue1' ? { id: 'o/a#1', title: 'タイトル' } : undefined,
      onAsk,
    });
    await new Promise((resolve) => server!.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return { checker, onAsk, port };
  }

  const post = (port: number, body: string, path = '/hooks/tool-risk?session=cc-a-issue1') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

  it('フックの入力とセッションの issue で判定し、ask なら応答と通知を返す', async () => {
    const { checker, onAsk, port } = await start(async () => ({
      decision: 'ask',
      reasons: ['Git push'],
    }));
    const res = await post(
      port,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' } })
    );
    expect((await res.json()).hookSpecificOutput.permissionDecision).toBe('ask');
    expect(checker.check).toHaveBeenCalledWith({
      session: 'cc-a-issue1',
      issueId: 'o/a#1',
      issueTitle: 'タイトル',
      toolName: 'Bash',
      toolInput: { command: 'git push' },
    });
    await vi.waitFor(() =>
      expect(onAsk).toHaveBeenCalledWith(
        'cc-a-issue1',
        { decision: 'ask', reasons: ['Git push'] },
        'git push'
      )
    );
  });

  it('許可なら空の応答を返し、通知しない', async () => {
    const { onAsk, port } = await start(async () => ({ decision: 'allow', reasons: [] }));
    const res = await post(port, JSON.stringify({ tool_name: 'Bash', tool_input: {} }));
    expect(await res.text()).toBe('{}');
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('壊れた入力や判定の失敗では許可する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { port } = await start(async () => {
      throw new Error('boom');
    });
    expect(await (await post(port, '{broken')).text()).toBe('{}');
    expect(await (await post(port, JSON.stringify({ tool_name: 'Bash' }))).text()).toBe('{}');
  });

  it('ほかのパスや GET は 404', async () => {
    const { port } = await start(async () => ({ decision: 'allow', reasons: [] }));
    expect((await post(port, '{}', '/other')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/hooks/tool-risk`)).status).toBe(404);
  });
});
