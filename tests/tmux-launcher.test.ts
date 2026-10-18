import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TmuxLauncher,
  buildActivityHookSettings,
  resolveCommandPath,
  toSessionName,
} from '../src/tmux-launcher.js';

/** execFile がコマンドの失敗で投げる形のエラー */
function exitError(code: number | string, stderr = '') {
  return Object.assign(new Error(`exit ${code}`), { code, stderr });
}

const noSession = () => exitError(1, "can't find session: cc-a-issue1\n");
const ok = { stdout: '', stderr: '' };

function makeLauncher(exec: ReturnType<typeof vi.fn>, sessionPath?: string) {
  return new TmuxLauncher({
    tmuxPath: '/opt/homebrew/bin/tmux',
    claudePath: '/Users/me/.local/bin/claude',
    cwd: '/workspace',
    sessionPath,
    exec,
    sleep: async () => {},
  });
}

describe('toSessionName', () => {
  it('cc-<リポジトリ名>-issue<番号> にする', () => {
    expect(toSessionName({ id: 'yama-shtshg-pp/xangi#14' })).toBe('cc-xangi-issue14');
  });

  it('tmux で使えない文字は - に置き換える', () => {
    expect(toSessionName({ id: 'o/my.repo:x#3' })).toBe('cc-my-repo-x-issue3');
  });

  it('issue 番号の形でない ID も、使える文字だけにする', () => {
    expect(toSessionName({ id: 'some.event:1' })).toBe('cc-some-event-1');
  });
});

describe('resolveCommandPath', () => {
  const canExecute = (path: string) => path === '/b/claude';

  it('PATH を順に探して絶対パスを返す', () => {
    expect(resolveCommandPath('claude', '/a:/b', canExecute)).toBe('/b/claude');
  });

  it('見つからなければ undefined', () => {
    expect(resolveCommandPath('claude', '/a', canExecute)).toBeUndefined();
  });

  it('/ を含む指定はそのパスを確かめる', () => {
    expect(resolveCommandPath('/b/claude', '', canExecute)).toBe('/b/claude');
    expect(resolveCommandPath('/a/claude', '/b', canExecute)).toBeUndefined();
  });
});

describe('TmuxLauncher', () => {
  it('完全一致でセッションを探し、あれば true', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    expect(await makeLauncher(exec).hasSession('cc-a-issue1')).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      '/opt/homebrew/bin/tmux',
      ['has-session', '-t', '=cc-a-issue1'],
      expect.anything()
    );
  });

  it('セッションがない・サーバーが動いていないときは false', async () => {
    for (const stderr of [
      "can't find session: cc-a-issue1",
      'no server running on /tmp/tmux-501/default',
      'error connecting to /tmp/tmux-501/default (No such file or directory)',
    ]) {
      const exec = vi.fn().mockRejectedValue(exitError(1, stderr));
      expect(await makeLauncher(exec).hasSession('cc-a-issue1')).toBe(false);
    }
  });

  it('ほかのエラーは「閉じた」と取り違えずに例外を投げる', async () => {
    const enoent = vi.fn().mockRejectedValue(exitError('ENOENT'));
    await expect(makeLauncher(enoent).hasSession('x')).rejects.toThrow('ENOENT');
    const denied = vi
      .fn()
      .mockRejectedValue(exitError(1, 'error connecting to /tmp/x (Permission denied)'));
    await expect(makeLauncher(denied).hasSession('x')).rejects.toThrow();
  });

  it('tmux の呼び出しにタイムアウトを付ける', async () => {
    const exec = vi.fn().mockResolvedValue(ok);
    await makeLauncher(exec).hasSession('x');
    expect(exec.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it('シークレットは tmux に渡さず、TMUX_TMPDIR と指定の PATH は渡す', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'secret');
    vi.stubEnv('TMUX_TMPDIR', '/Users/me/.tmux-tmp');
    try {
      const exec = vi.fn().mockResolvedValue(ok);
      await makeLauncher(exec, '/wrapper:/usr/bin').hasSession('x');
      const { env } = exec.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(env.DISCORD_TOKEN).toBeUndefined();
      expect(env.TMUX_TMPDIR).toBe('/Users/me/.tmux-tmp');
      expect(env.PATH).toBe('/wrapper:/usr/bin');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('作業ディレクトリを渡すと、そのディレクトリでセッションを作る', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(noSession())
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(ok);

    expect(await makeLauncher(exec).launch('cc-a-issue1', 'p', '/repos/a')).toBe(true);
    const args = exec.mock.calls[1][1] as string[];
    expect(args[args.indexOf('-c') + 1]).toBe('/repos/a');
  });

  it('新しいセッションで claude を対話モードで起動し、プロンプトはシェルを通さず 1 つの引数で渡す', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(noSession()) // has-session: なし
      .mockResolvedValueOnce(ok) // new-session
      .mockResolvedValueOnce(ok); // 起動後の has-session: まだ動いている
    const prompt = 'a "q" $(touch /tmp/x) `id`\n${HOME}';

    expect(await makeLauncher(exec).launch('cc-a-issue1', prompt)).toBe(true);
    expect(exec).toHaveBeenNthCalledWith(
      2,
      '/opt/homebrew/bin/tmux',
      [
        'new-session',
        '-d',
        '-s',
        'cc-a-issue1',
        '-c',
        '/workspace',
        '--',
        '/Users/me/.local/bin/claude',
        '-n',
        'cc-a-issue1',
        '--remote-control',
        'cc-a-issue1',
        prompt,
      ],
      expect.anything()
    );
  });

  it('claude が起動してすぐに終了したら例外を投げる', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(noSession())
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(noSession());
    await expect(makeLauncher(exec).launch('cc-a-issue1', 'p')).rejects.toThrow(
      'claude exited right after launch'
    );
  });

  it('同じ名前のセッションがあれば起動しない', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    expect(await makeLauncher(exec).launch('cc-a-issue1', 'p')).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('buildActivityHookSettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-hook-'q "));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commandOf(settings: string, event: string): string {
    const hooks = JSON.parse(settings).hooks[event] as { hooks: { command: string }[] }[];
    return hooks[0].hooks[0].command;
  }

  it('返答を終えたら idle、指示やツールの前後で busy を書く（引用符や空白を含むパスでも）', () => {
    const statePath = join(dir, 'cc-a-issue1');
    const settings = buildActivityHookSettings(statePath);
    for (const [event, state] of [
      ['Stop', 'idle'],
      ['Notification', 'idle'],
      ['UserPromptSubmit', 'busy'],
      ['PreToolUse', 'busy'],
      ['PostToolUse', 'busy'],
    ]) {
      execFileSync('/bin/sh', ['-c', commandOf(settings, event)]);
      expect(readFileSync(statePath, 'utf-8')).toBe(state);
    }
  });

  it('Notification は入力を待つ通知だけに絞る', () => {
    const notification = JSON.parse(buildActivityHookSettings('/s')).hooks.Notification;
    expect(notification[0].matcher).toBe('permission_prompt|idle_prompt|elicitation_dialog');
  });
});

describe('TmuxLauncher の状態の記録', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmux-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStateLauncher(exec: ReturnType<typeof vi.fn>) {
    return new TmuxLauncher({
      tmuxPath: '/opt/homebrew/bin/tmux',
      claudePath: '/Users/me/.local/bin/claude',
      cwd: '/workspace',
      stateDir: join(dir, 'event-sessions'),
      exec,
      sleep: async () => {},
    });
  }

  it('stateDir があれば --settings でフックを渡し、前の状態を busy で上書きして起動する', async () => {
    const stateDir = join(dir, 'event-sessions');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'cc-a-issue1'), 'idle');
    const exec = vi.fn().mockRejectedValueOnce(noSession()).mockResolvedValue(ok);
    const launcher = makeStateLauncher(exec);

    await launcher.launch('cc-a-issue1', 'prompt');

    const args = exec.mock.calls[1][1] as string[];
    const i = args.indexOf('--settings');
    expect(args[i + 1]).toBe(buildActivityHookSettings(join(stateDir, 'cc-a-issue1')));
    expect(args.at(-1)).toBe('prompt');
    expect(launcher.getActivity('cc-a-issue1')).toBe('busy');
  });

  it('getActivity はフックが書いた状態を返し、なければ unknown', () => {
    const launcher = makeStateLauncher(vi.fn());
    expect(launcher.getActivity('cc-a-issue1')).toBe('unknown');
    mkdirSync(join(dir, 'event-sessions'));
    writeFileSync(join(dir, 'event-sessions', 'cc-a-issue1'), 'idle');
    expect(launcher.getActivity('cc-a-issue1')).toBe('idle');
    writeFileSync(join(dir, 'event-sessions', 'cc-a-issue1'), 'busy');
    expect(launcher.getActivity('cc-a-issue1')).toBe('busy');
  });

  it('stateDir がなければフックを付けず、状態は unknown', async () => {
    const exec = vi.fn().mockRejectedValueOnce(noSession()).mockResolvedValue(ok);
    const launcher = makeLauncher(exec);
    await launcher.launch('cc-a-issue1', 'prompt');
    expect(exec.mock.calls[1][1]).not.toContain('--settings');
    expect(launcher.getActivity('cc-a-issue1')).toBe('unknown');
  });
});
