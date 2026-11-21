import { describe, it, expect } from 'vitest';
import { issueProgress, parseBlockedBy, parseRunAfter } from '../src/run-after.js';

describe('parseRunAfter', () => {
  it('行がなければ none', () => {
    expect(parseRunAfter('本文だけ', 'o/a')).toEqual({ kind: 'none' });
  });

  it('#番号は同じリポジトリ、owner/repo#番号は別のリポジトリ', () => {
    expect(parseRunAfter('前置き\nxangi-run-after: #12, other/b#3\n後ろ', 'o/a')).toEqual({
      kind: 'valid',
      issues: [
        { repo: 'o/a', number: 12 },
        { repo: 'other/b', number: 3 },
      ],
    });
  });

  it('行が複数あれば、すべての行の issue を待ち、重なりは 1 つにする', () => {
    expect(parseRunAfter('xangi-run-after: #1\nxangi-run-after:  #2 , O/A#1 ', 'o/a')).toEqual({
      kind: 'valid',
      issues: [
        { repo: 'o/a', number: 1 },
        { repo: 'o/a', number: 2 },
      ],
    });
  });

  it('行頭にない行は読まない', () => {
    expect(parseRunAfter('メモ xangi-run-after: #1', 'o/a')).toEqual({ kind: 'none' });
  });

  it.each(['', '12', '#abc', '#1,', '#1 #2', 'o/#1', 'https://github.com/o/a/pull/1'])(
    '読めない値 "%s" なら invalid',
    (value) => {
      expect(parseRunAfter(`xangi-run-after: ${value}`, 'o/a')).toEqual({
        kind: 'invalid',
        value,
      });
    }
  );
});

describe('parseRunAfter の新しい書き方', () => {
  const one = { kind: 'valid', issues: [{ repo: 'o/a', number: 1 }] };

  it('待つ: と全角コロンを読む', () => {
    expect(parseRunAfter('待つ: #1', 'o/a')).toEqual(one);
    expect(parseRunAfter('待つ：#1', 'o/a')).toEqual(one);
    expect(parseRunAfter('xangi-run-after：#1', 'o/a')).toEqual(one);
  });

  it('xangi-run-after と 待つ の複数行をすべて読む', () => {
    expect(parseRunAfter('xangi-run-after: #1\n待つ: #2, #1', 'o/a')).toEqual({
      kind: 'valid',
      issues: [
        { repo: 'o/a', number: 1 },
        { repo: 'o/a', number: 2 },
      ],
    });
  });

  it('repo#番号の owner は、本文を書いた issue の owner', () => {
    expect(parseRunAfter('待つ: dotfile#3', 'me/a')).toEqual({
      kind: 'valid',
      issues: [{ repo: 'me/dotfile', number: 3 }],
    });
  });

  it('issue の URL を読み、末尾の # や ? は無視する', () => {
    expect(
      parseRunAfter(
        '待つ: https://github.com/o/b/issues/5, https://github.com/o/b/issues/6#issuecomment-1, https://github.com/o/b/issues/7?x=1',
        'o/a'
      )
    ).toEqual({
      kind: 'valid',
      issues: [
        { repo: 'o/b', number: 5 },
        { repo: 'o/b', number: 6 },
        { repo: 'o/b', number: 7 },
      ],
    });
  });

  it('4 つの形をカンマで混ぜて書ける', () => {
    expect(
      parseRunAfter('待つ: #12, dotfile#3, other/b#4, https://github.com/o/c/issues/5', 'o/a')
    ).toEqual({
      kind: 'valid',
      issues: [
        { repo: 'o/a', number: 12 },
        { repo: 'o/dotfile', number: 3 },
        { repo: 'other/b', number: 4 },
        { repo: 'o/c', number: 5 },
      ],
    });
  });

  it('同じ issue を別の形で書いても 1 つにする', () => {
    expect(parseRunAfter('待つ: #1, o/a#1, a#1, https://github.com/O/a/issues/1', 'o/a')).toEqual(
      one
    );
  });

  it.each([
    'https://github.com/o/a/pull/3',
    'https://github.com/o/a/issues/x',
    'https://example.com/o/a/issues/3',
    '#1, https://github.com/o/a/pull/3',
    'a/b/c#1',
  ])('読めない値 "%s" は invalid', (value) => {
    expect(parseRunAfter(`待つ: ${value}`, 'o/a')).toEqual({ kind: 'invalid', value });
  });
});

describe('parseBlockedBy', () => {
  const item = (repo: string, number: number, state: string, reason: string | null) => ({
    number,
    state,
    state_reason: reason,
    repository_url: `https://api.github.com/repos/${repo}`,
  });

  it('repository_url から repo を、number・state・state_reason を取る。null の理由は空にする', () => {
    const out = parseBlockedBy(
      JSON.stringify([
        item('o/b', 3, 'closed', 'completed'),
        item('o/a', 4, 'open', null),
        item('o/a', 5, 'closed', 'not_planned'),
      ])
    );
    expect(out).toEqual([
      { issue: { repo: 'o/b', number: 3 }, state: { state: 'CLOSED', stateReason: 'COMPLETED' } },
      { issue: { repo: 'o/a', number: 4 }, state: { state: 'OPEN', stateReason: '' } },
      {
        issue: { repo: 'o/a', number: 5 },
        state: { state: 'CLOSED', stateReason: 'NOT_PLANNED' },
      },
    ]);
    // 大文字にして比べるので、そのまま issueProgress に渡せる
    expect(out.map((b) => issueProgress(b.state))).toEqual(['completed', 'open', 'not_completed']);
  });

  it('空の配列と空の出力は、Blocked by なし', () => {
    expect(parseBlockedBy('[]')).toEqual([]);
    expect(parseBlockedBy('')).toEqual([]);
  });

  it('gh --paginate が返す、つなげた複数の配列も読む', () => {
    const out = parseBlockedBy(
      `${JSON.stringify([item('o/a', 1, 'open', null)])}\n${JSON.stringify([item('o/a', 2, 'open', null)])}`
    );
    expect(out.map((b) => b.issue.number)).toEqual([1, 2]);
  });

  it('読めない出力は例外を投げる', () => {
    expect(() => parseBlockedBy('not json')).toThrow();
    expect(() => parseBlockedBy('[{"number":1}]')).toThrow();
  });
});

describe('issueProgress', () => {
  it('open なら open', () => {
    expect(issueProgress({ state: 'OPEN', stateReason: 'REOPENED' })).toBe('open');
  });

  it('completed か、理由のない close なら completed', () => {
    expect(issueProgress({ state: 'CLOSED', stateReason: 'COMPLETED' })).toBe('completed');
    expect(issueProgress({ state: 'CLOSED', stateReason: '' })).toBe('completed');
  });

  it('OPEN と CLOSED 以外（PR の MERGED など）は unknown', () => {
    expect(issueProgress({ state: 'MERGED', stateReason: '' })).toBe('unknown');
  });

  it('not planned や duplicate で閉じたら not_completed', () => {
    expect(issueProgress({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('not_completed');
    expect(issueProgress({ state: 'CLOSED', stateReason: 'DUPLICATE' })).toBe('not_completed');
  });
});
