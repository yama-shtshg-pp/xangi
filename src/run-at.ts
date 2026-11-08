/**
 * issue の本文に書いた起動日時（`xangi-run-at: <日時>`）を読む
 *
 * Why: 「◯日に結果を確認する」issue は、立てた日に起動しても何もできない。
 * ラベルを増やさず、本文の 1 行で起動日を指定できるようにする。
 * 日時は JST 固定。日付だけなら 09:00 に起動する。
 */

/** 行頭の `xangi-run-at:` の値を取る。複数あれば最初の行を使う */
const RUN_AT_LINE = /^xangi-run-at:[ \t]*(.*?)[ \t]*$/m;
const RUN_AT_VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** 日付だけ書いたときの起動時刻（JST） */
const DEFAULT_HOUR = 9;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type RunAt =
  | { kind: 'none' }
  | { kind: 'valid'; at: Date }
  | { kind: 'invalid'; value: string };

/** 本文から起動日時を読む。行がなければ none、値を読めなければ invalid */
export function parseRunAt(body: string): RunAt {
  const line = RUN_AT_LINE.exec(body);
  if (!line) return { kind: 'none' };
  const value = line[1];
  const m = RUN_AT_VALUE.exec(value);
  if (!m) return { kind: 'invalid', value };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = m[4] === undefined ? DEFAULT_HOUR : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (hour > 23 || minute > 59) return { kind: 'invalid', value };
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  // 2026-02-30 のような存在しない日は Date.UTC が翌月に繰り上げるので、戻して比べる
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { kind: 'invalid', value };
  }
  return { kind: 'valid', at: new Date(utc - JST_OFFSET_MS) };
}
