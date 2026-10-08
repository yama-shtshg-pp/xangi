import { describe, it, expect, vi } from 'vitest';
import { TmuxLauncher, resolveCommandPath, toSessionName } from '../src/tmux-launcher.js';

/** 終了コード付きのエラー（execFile がコマンドの失敗で投げる形） */
function exitError(code: number | string) {
  return Object.assign(new Error(`exit ${code}`), { code });
}

function makeLauncher(exec: ReturnType<typeof vi.fn>) {
  return new TmuxLauncher({
    tmuxPath: '/opt/homebrew/bin/tmux',
    claudePath: '/Users/me/.local/bin/claude',
    cwd: '/workspace',
    exec,
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

  it('終了コードが返ればセッションなしとみなす', async () => {
    const exec = vi.fn().mockRejectedValue(exitError(1));
    expect(await makeLauncher(exec).hasSession('cc-a-issue1')).toBe(false);
  });

  it('tmux を実行できないときは例外を投げる', async () => {
    const exec = vi.fn().mockRejectedValue(exitError('ENOENT'));
    await expect(makeLauncher(exec).hasSession('cc-a-issue1')).rejects.toThrow('ENOENT');
  });

  it('シークレットを含む環境変数を tmux に渡さない', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'secret');
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
      await makeLauncher(exec).hasSession('x');
      const { env } = exec.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(env.DISCORD_TOKEN).toBeUndefined();
      expect(env.PATH).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('新しいセッションで claude を対話モードで起動し、プロンプトはシェルを通さず 1 つの引数で渡す', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(exitError(1)) // has-session: なし
      .mockResolvedValue({ stdout: '', stderr: '' });
    const prompt = 'a "q" $(touch /tmp/x) `id`\n${HOME}';

    expect(await makeLauncher(exec).launch('cc-a-issue1', prompt)).toBe(true);
    expect(exec).toHaveBeenLastCalledWith(
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

  it('同じ名前のセッションがあれば起動しない', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    expect(await makeLauncher(exec).launch('cc-a-issue1', 'p')).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
