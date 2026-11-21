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

  it.each(['2026-02-30', '2026-13-01', '2026-11-20T24:00', '2026-11-20T09:60', ''])(
    '読めない値 "%s" は invalid',
    (value) => {
      expect(parseRunAt(`xangi-run-at: ${value}`)).toEqual({ kind: 'invalid', value });
    }
  );

  describe('起動 / 起動日 の行と、日本語の書き方', () => {
    const at = (iso: string) => ({ kind: 'valid', at: new Date(iso) });

    it.each([
      ['起動: 2026-11-20'],
      ['起動：2026-11-20'],
      ['起動日: 2026-11-20'],
      ['起動日：2026-11-20'],
      ['xangi-run-at：2026-11-20'],
    ])('行 "%s" を読む', (line) => {
      expect(parseRunAt(line)).toEqual(at('2026-11-20T00:00:00Z'));
    });

    it('キーワードが違っても、最初に出た行を使う', () => {
      expect(parseRunAt('起動: 2026-11-20\nxangi-run-at: 2026-12-01')).toEqual(
        at('2026-11-20T00:00:00Z')
      );
      expect(parseRunAt('xangi-run-at: 2026-12-01\n起動日: 2026-11-20')).toEqual(
        at('2026-12-01T00:00:00Z')
      );
    });

    it('行頭にない「起動:」は読まない', () => {
      expect(parseRunAt('メモ 起動: 2026-11-20')).toEqual({ kind: 'none' });
    });

    it.each([
      ['2026/11/20', '2026-11-20T00:00:00Z'],
      ['2026年11月20日', '2026-11-20T00:00:00Z'],
      ['2026-1-5', '2026-01-05T00:00:00Z'],
      ['2026年1月5日', '2026-01-05T00:00:00Z'],
    ])('日付 "%s" を読む', (value, iso) => {
      expect(parseRunAt(`起動: ${value}`)).toEqual(at(iso));
    });

    it.each([
      ['2026-11-20 14:00', '2026-11-20T05:00:00Z'],
      ['2026-11-20T14:00', '2026-11-20T05:00:00Z'],
      ['2026-11-20 14時', '2026-11-20T05:00:00Z'],
      ['2026-11-20 14時30分', '2026-11-20T05:30:00Z'],
      ['2026-11-20　14時', '2026-11-20T05:00:00Z'],
      ['2026年11月20日14時', '2026-11-20T05:00:00Z'],
      ['2026年11月20日 9:05', '2026-11-20T00:05:00Z'],
      ['2026/11/20 9時', '2026-11-20T00:00:00Z'],
    ])('時刻つき "%s" を読む', (value, iso) => {
      expect(parseRunAt(`起動: ${value}`)).toEqual(at(iso));
    });

    it.each([
      '2026-11-20 25時',
      '2026-11-20 24:00',
      '2026-11-20 14時60分',
      '2026-11-20 T14:00',
      '2026年13月1日',
      '2026/02/30',
      'あした',
      '2026-11-20 14',
      '2026-11-2014:00',
      '2026-11-2014時',
      '2026/11/2014:00',
      '11/2014時',
    ])('読めない値 "%s" は invalid', (value) => {
      expect(parseRunAt(`起動: ${value}`)).toEqual({ kind: 'invalid', value });
    });

    describe('年を省いた日付', () => {
      const created = '2026-11-01T00:00:00Z';

      it.each([
        ['11/20', '2026-11-20T00:00:00Z'],
        ['11月20日', '2026-11-20T00:00:00Z'],
        ['11/20 14時', '2026-11-20T05:00:00Z'],
        ['11月20日14:00', '2026-11-20T05:00:00Z'],
        ['11月20日14時30分', '2026-11-20T05:30:00Z'],
        ['1/5', '2027-01-05T00:00:00Z'],
        ['1月5日 14:00', '2027-01-05T05:00:00Z'],
        ['11/01', '2026-11-01T00:00:00Z'],
        ['10/31', '2027-10-31T00:00:00Z'],
      ])('作った日 2026-11-01 のとき "%s"', (value, iso) => {
        expect(parseRunAt(`起動: ${value}`, created)).toEqual(at(iso));
        expect(parseRunAt(`起動: ${value}`, new Date(created))).toEqual(at(iso));
      });

      it('作った日は JST で数える', () => {
        // 2026-11-01T20:00Z は JST の 2026-11-02 05:00
        expect(parseRunAt('起動: 11/02', '2026-11-01T20:00:00Z')).toEqual(
          at('2026-11-02T00:00:00Z')
        );
        expect(parseRunAt('起動: 11/01', '2026-11-01T20:00:00Z')).toEqual(
          at('2027-11-01T00:00:00Z')
        );
      });

      it('作った日がなければ invalid', () => {
        expect(parseRunAt('起動: 11/20')).toEqual({ kind: 'invalid', value: '11/20' });
      });

      it('選んだ年に存在しない日は invalid', () => {
        expect(parseRunAt('起動: 2/29', created)).toEqual({ kind: 'invalid', value: '2/29' });
      });

      it('年を書いた日付は、作った日があっても書いた年のまま', () => {
        expect(parseRunAt('起動: 2025-01-05', created)).toEqual(at('2025-01-05T00:00:00Z'));
      });
    });
  });
});
