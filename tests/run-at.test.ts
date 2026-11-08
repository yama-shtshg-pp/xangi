import { describe, it, expect } from 'vitest';
import { parseRunAt } from '../src/run-at.js';

describe('parseRunAt', () => {
  it('行がなければ none', () => {
    expect(parseRunAt('本文だけ')).toEqual({ kind: 'none' });
  });

  it('日付だけなら JST の 09:00', () => {
    expect(parseRunAt('xangi-run-at: 2026-11-20')).toEqual({
      kind: 'valid',
      at: new Date('2026-11-20T00:00:00Z'),
    });
  });

  it('時刻を書いたら JST のその時刻', () => {
    expect(parseRunAt('前置き\nxangi-run-at: 2026-11-20T14:30\n後ろ')).toEqual({
      kind: 'valid',
      at: new Date('2026-11-20T05:30:00Z'),
    });
  });

  it('JST の 09:00 より前の時刻は、UTC では前の日になる', () => {
    expect(parseRunAt('xangi-run-at: 2026-11-20T08:00')).toEqual({
      kind: 'valid',
      at: new Date('2026-11-19T23:00:00Z'),
    });
  });

  it('行頭にない行は読まない', () => {
    expect(parseRunAt('メモ xangi-run-at: 2026-11-20')).toEqual({ kind: 'none' });
  });

  it('複数あれば最初の行を使う', () => {
    expect(parseRunAt('xangi-run-at: 2026-11-20\nxangi-run-at: 2026-12-01')).toEqual({
      kind: 'valid',
      at: new Date('2026-11-20T00:00:00Z'),
    });
  });

  it.each([
    '2026/11/20',
    '2026-11-20 14:00',
    '2026-02-30',
    '2026-13-01',
    '2026-11-20T24:00',
    '2026-11-20T09:60',
    '',
  ])('読めない値 "%s" は invalid', (value) => {
    expect(parseRunAt(`xangi-run-at: ${value}`)).toEqual({ kind: 'invalid', value });
  });
});
