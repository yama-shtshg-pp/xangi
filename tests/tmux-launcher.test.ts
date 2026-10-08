import { describe, it, expect, vi } from 'vitest';
import { TmuxLauncher, resolveCommandPath, toSessionName } from '../src/tmux-launcher.js';

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
