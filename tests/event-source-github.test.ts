import { describe, it, expect, vi } from 'vitest';
import { GitHubIssueSource } from '../src/event-source-github.js';

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
    const source = new GitHubIssueSource(['o/a'], 'agent', gh);

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
    const source = new GitHubIssueSource(['o/broken', 'o/a'], 'agent', gh);

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
    const events = await new GitHubIssueSource(['o/a'], 'agent', gh).poll();
    expect(events.map((e) => e.id)).toEqual(['o/a#3', 'o/a#12', 'o/a#14']);
  });

  it('本文が null の issue は空文字にする', async () => {
    const gh = vi.fn().mockResolvedValue(JSON.stringify([{ ...issues[0], body: null }]));
    const [event] = await new GitHubIssueSource(['o/a'], 'agent', gh).poll();
    expect(event.body).toBe('');
  });
});
