import { describe, it, expect, vi } from 'vitest';
import { GitHubIssueSource, type RepoTarget } from '../src/event-source-github.js';

function targets(repos: string[], label = 'agent'): () => Promise<RepoTarget[]> {
  return async () => repos.map((repo) => ({ repo, label }));
}

const issues = [
  {
    number: 12,
    title: 'ログを整理する',
    body: '本文',
    url: 'https://github.com/o/a/issues/12',
    labels: [{ name: 'agent' }, { name: 'bug' }],
  },
];

describe('GitHubIssueSource', () => {
  it('ラベルと open で絞って gh issue list を呼び、イベントに変換する', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify(issues));
    const source = new GitHubIssueSource(targets(['o/a']), gh);

    const events = await source.poll();

    expect(gh).toHaveBeenCalledWith([
      'issue',
      'list',
      '--repo',
      'o/a',
      '--label',
      'agent',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,title,body,url,labels',
    ]);
    expect(events).toEqual([
      {
        source: 'github-issue',
        id: 'o/a#12',
        title: 'ログを整理する',
        body: '本文',
        url: 'https://github.com/o/a/issues/12',
        labels: ['agent', 'bug'],
      },
    ]);
  });

  it('1 つのリポジトリで失敗しても、ほかのリポジトリの結果は返す', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gh = vi.fn(async (args: string[]) => {
      if (args[3] === 'o/broken') throw new Error('gh: not found');
      return JSON.stringify(issues);
    });
    const source = new GitHubIssueSource(targets(['o/broken', 'o/a']), gh);

    const events = await source.poll();

    expect(events.map((e) => e.id)).toEqual(['o/a#12']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('gh が新しい順に返しても、issue 番号の古い順に並べる', async () => {
    const gh = vi.fn().mockResolvedValue(
      JSON.stringify([
        { ...issues[0], number: 14 },
        { ...issues[0], number: 3 },
        { ...issues[0], number: 12 },
      ])
    );
    const events = await new GitHubIssueSource(targets(['o/a']), gh).poll();
    expect(events.map((e) => e.id)).toEqual(['o/a#3', 'o/a#12', 'o/a#14']);
  });

  it('本文が null の issue は空文字にする', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify([{ ...issues[0], body: null }]));
    const [event] = await new GitHubIssueSource(targets(['o/a']), gh).poll();
    expect(event.body).toBe('');
  });

  it('リポジトリごとのラベルで絞り、作業ディレクトリと通知先をイベントに持たせる', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify(issues));
    const source = new GitHubIssueSource(
      async () => [{ repo: 'o/a', label: 'bot', workdir: '/repos/a', notifyChannelId: '123' }],
      gh
    );

    const [event] = await source.poll();

    expect(gh.mock.calls[0][0]).toContain('bot');
    expect(event.workdir).toBe('/repos/a');
    expect(event.notifyChannelId).toBe('123');
  });

  it('ポーリングのたびに対象の一覧を取り直す', async () => {
    const gh = vi.fn().mockResolvedValue('[]');
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ repo: 'o/a', label: 'agent' }])
      .mockResolvedValueOnce([{ repo: 'o/b', label: 'agent' }]);
    const source = new GitHubIssueSource(list, gh);

    await source.poll();
    await source.poll();

    expect(gh.mock.calls.map((c) => c[0][3])).toEqual(['o/a', 'o/b']);
  });

  it('対象の一覧を取れないときは、そのポーリングを失敗にする', async () => {
    const gh = vi.fn();
    const source = new GitHubIssueSource(async () => {
      throw new Error('bad json');
    }, gh);

    await expect(source.poll()).rejects.toThrow('bad json');
    expect(gh).not.toHaveBeenCalled();
  });
});
