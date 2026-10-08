import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  WatchRepoList,
  expandHome,
  locateJsonError,
  parseGitHubRepo,
  parseWatchRepos,
  type GitExec,
} from '../src/watch-repos.js';

describe('parseGitHubRepo', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['git@github-sub:owner/my.repo.git', 'owner/my.repo'],
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
  ])('%s → %s', (url, repo) => {
    expect(parseGitHubRepo(url)).toBe(repo);
  });

  it.each([
    'https://gitlab.com/owner/repo.git',
    'https://github.com/owner',
    'https://github.com/owner/repo/extra',
    '/local/path/repo',
    'not a url',
  ])('読み取れない: %s', (url) => {
    expect(parseGitHubRepo(url)).toBeUndefined();
  });
});

describe('expandHome', () => {
  it('~ と ~/ を展開し、ほかはそのまま', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/git/a', '/home/u')).toBe('/home/u/git/a');
    expect(expandHome('/abs/~x', '/home/u')).toBe('/abs/~x');
  });
});

describe('parseWatchRepos', () => {
  it('項目を読む', () => {
    expect(parseWatchRepos('{"repos":[{"path":"~/a","enabled":false}]}')).toEqual([
      { path: '~/a', enabled: false },
    ]);
  });

  it.each([
    ['{\n "repos": [\n],\n}', 4, 1],
    ['{ "repos": [ }', 1, 14],
    ['{\n "repos": [\n  {"path": "/a"} {"path": "/b"}\n ]\n}', 3, 18],
  ])('locateJsonError: %j → %i 行 %i 列', (text, line, column) => {
    expect(locateJsonError(text)).toEqual({ line, column });
  });

  it('JSON の形式エラーは行番号の分かるメッセージにする', () => {
    expect(() => parseWatchRepos('{\n "repos": [\n],\n}')).toThrow(/line 4/);
  });

  it.each([
    ['{}', '"repos" must be an array'],
    ['{"repos":["a"]}', 'repos[0] must be an object'],
    ['{"repos":[{}]}', 'repos[0].path is required'],
    ['{"repos":[{"path":""}]}', 'repos[0].path must be a non-empty string'],
    ['{"repos":[{"path":"/a","label":1}]}', 'repos[0].label must be a non-empty string'],
    ['{"repos":[{"path":"/a","enabled":"no"}]}', 'repos[0].enabled must be true or false'],
    ['{"repos":[{"path":"/a","repo":"repo-only"}]}', 'repos[0].repo must be owner/repo'],
  ])('形がおかしい: %s', (text, message) => {
    expect(() => parseWatchRepos(text)).toThrow(message);
  });
});

describe('WatchRepoList', () => {
  let dir: string;
  let home: string;
  let filePath: string;
  let notify: ReturnType<typeof vi.fn>;
  /** path → remote 名 → URL。ないパスは git リポジトリでないとみなす */
  let remotes: Record<string, Record<string, string>>;
  let git: GitExec;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'watch-repos-'));
    home = join(dir, 'home');
    for (const name of ['a', 'b', 'fork', 'plain', 'no-remote']) {
      mkdirSync(join(home, name), { recursive: true });
    }
    filePath = join(dir, 'watch-repos.json');
    notify = vi.fn().mockResolvedValue(undefined);
    remotes = {
      [join(home, 'a')]: { origin: 'git@github-sub:o/a.git' },
      [join(home, 'b')]: { origin: 'https://github.com/o/b.git' },
      [join(home, 'fork')]: {
        origin: 'git@github.com:me/fork.git',
        upstream: 'git@github.com:up/fork.git',
      },
      [join(home, 'no-remote')]: {},
    };
    git = vi.fn(async (args: string[]) => {
      const repo = remotes[args[1]];
      if (!repo) throw new Error('fatal: not a git repository');
      if (args[2] === 'rev-parse') return 'true\n';
      const url = repo[args[4]];
      if (!url) throw new Error(`error: No such remote '${args[4]}'`);
      return `${url}\n`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(repos: unknown[]): void {
    writeFileSync(filePath, JSON.stringify({ repos }));
  }

  function makeList() {
    return new WatchRepoList({
      filePath,
      defaults: { label: 'agent', notifyChannelId: 'default-ch' },
      notify,
      git,
      home,
    });
  }

  it('パスを展開し、remote から owner/repo を読み取る。省略した項目は既定値にする', async () => {
    write([
      { path: '~/a' },
      { path: '~/fork', remote: 'upstream', label: 'bot', notifyChannelId: 'ch' },
    ]);

    expect(await makeList().load()).toEqual([
      { repo: 'o/a', label: 'agent', workdir: join(home, 'a'), notifyChannelId: 'default-ch' },
      { repo: 'up/fork', label: 'bot', workdir: join(home, 'fork'), notifyChannelId: 'ch' },
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('repo を書いたら remote から読み取らない', async () => {
    write([{ path: '~/fork', repo: 'x/y' }]);
    const [target] = await makeList().load();
    expect(target.repo).toBe('x/y');
    expect(git).not.toHaveBeenCalledWith(expect.arrayContaining(['remote']));
  });

  it('enabled: false の項目は飛ばし、通知もしない', async () => {
    write([
      { path: '~/a', enabled: false },
      { path: '~/missing', enabled: false },
    ]);
    expect(await makeList().load()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ポーリングのたびにファイルを読み直す', async () => {
    const list = makeList();
    write([{ path: '~/a' }]);
    expect((await list.load()).map((t) => t.repo)).toEqual(['o/a']);
    write([{ path: '~/b' }]);
    expect((await list.load()).map((t) => t.repo)).toEqual(['o/b']);
  });

  it('ファイルが読めない・形式がおかしいときは投げる', async () => {
    const list = makeList();
    await expect(list.load()).rejects.toThrow(filePath);
    writeFileSync(filePath, '{ "repos": [ }');
    await expect(list.load()).rejects.toThrow(/line 1 column 14/);
  });

  it.each([
    ['~/missing', 'directory not found'],
    ['relative/path', 'path must be absolute'],
    ['~/plain', 'not a git repository'],
    ['~/no-remote', "git remote get-url origin failed: error: No such remote 'origin'"],
  ])('%s は飛ばして通知する（%s）', async (path, message) => {
    write([{ path, notifyChannelId: 'ch' }, { path: '~/a' }]);

    expect((await makeList().load()).map((t) => t.repo)).toEqual(['o/a']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain(message);
    expect(notify.mock.calls[0][1]).toBe('ch');
  });

  it('remote の URL から owner/repo を読み取れなければ飛ばして通知する', async () => {
    remotes[join(home, 'a')].origin = 'https://gitlab.com/o/a.git';
    write([{ path: '~/a' }]);
    expect(await makeList().load()).toEqual([]);
    expect(notify.mock.calls[0][0]).toContain('cannot read owner/repo');
    expect(notify.mock.calls[0][1]).toBe('default-ch');
  });

  it('同じ問題は 1 回だけ通知し、解消したあとに再発したらまた通知する', async () => {
    const list = makeList();
    write([{ path: '~/missing' }]);
    await list.load();
    await list.load();
    expect(notify).toHaveBeenCalledTimes(1);

    write([]);
    await list.load();
    write([{ path: '~/missing' }]);
    await list.load();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('同じリポジトリを 2 か所から見ていたら、後の項目を飛ばして通知する', async () => {
    remotes[join(home, 'b')].origin = 'git@github.com:O/A.git';
    write([{ path: '~/a' }, { path: '~/b' }]);

    expect((await makeList().load()).map((t) => t.workdir)).toEqual([join(home, 'a')]);
    expect(notify.mock.calls[0][0]).toContain('already watched');
  });

  it('ファイルが読めないときは、同じエラーを 1 回だけ既定の通知先に通知する', async () => {
    const list = makeList();
    writeFileSync(filePath, '{ "repos": [ }');
    await expect(list.load()).rejects.toThrow();
    await expect(list.load()).rejects.toThrow();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('ポーリングを止めています');
    expect(notify.mock.calls[0][1]).toBe('default-ch');
  });

  it('git が失敗した理由を通知に入れる（git リポジトリでないと決めつけない）', async () => {
    git = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'timed out\nmore' });
    });
    write([{ path: '~/a' }]);
    await makeList().load();
    expect(notify.mock.calls[0][0]).toContain('git rev-parse failed: timed out');
  });

  it('通知に失敗したら、次のポーリングで送り直す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    notify.mockRejectedValueOnce(new Error('Missing Access'));
    const list = makeList();
    write([{ path: '~/missing' }]);
    await list.load();
    await list.load();
    await list.load();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('通知に失敗しても対象の一覧は返す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    notify.mockRejectedValue(new Error('Missing Access'));
    write([{ path: '~/missing' }, { path: '~/a' }]);
    expect((await makeList().load()).map((t) => t.repo)).toEqual(['o/a']);
  });
});
