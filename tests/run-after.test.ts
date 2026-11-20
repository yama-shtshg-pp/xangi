import { describe, it, expect } from 'vitest';
import { issueProgress, parseRunAfter } from '../src/run-after.js';

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

  it.each(['', '12', '#abc', '#1,', '#1 #2', 'o#1', 'https://github.com/o/a/issues/1'])(
    '読めない値 "%s" なら invalid',
    (value) => {
      expect(parseRunAfter(`xangi-run-after: ${value}`, 'o/a')).toEqual({
        kind: 'invalid',
        value,
      });
    }
  );
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
