/**
 * issue の本文に書いた起動日時（`xangi-run-at: <日時>`、`起動: <日時>`、`起動日: <日時>`）を読む
 *
 * Why: 「◯日に結果を確認する」issue は、立てた日に起動しても何もできない。
 * ラベルを増やさず、本文の 1 行で起動日を指定できるようにする。
 * 日時は JST 固定。日付だけなら 09:00 に起動する。
 * 人が手で書くので、日本語でよく使う書き方（`11/20 14時`、`2026年11月20日`）も読む。
 */

/**
 * 行頭のキーワードに続く値を取る。複数あれば、キーワードが違っても最初の行を使う
 * `起動日：` を `起動` + `日：` と読まないよう、区切りの直前までをキーワードにする
 */
const RUN_AT_LINE = /^(?:xangi-run-at|起動日|起動)[:：][ \t]*(.*?)[ \t]*$/m;

/** 日付の書き方。年を省いた形は year の位置が空になる */
const DATE_PATTERNS: { re: RegExp; hasYear: boolean }[] = [
  { re: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, hasYear: true },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日/, hasYear: true },
  { re: /^(\d{1,2})\/(\d{1,2})/, hasYear: false },
  { re: /^(\d{1,2})月(\d{1,2})日/, hasYear: false },
];
const SPACE = '[ \\t\\u3000]*';
/** 日付のあとの時刻。`T14:00`（T の前に空白なし）、`14:00`、`14時`、`14時30分` */
const TIME_PATTERNS: RegExp[] = [
  /^T(\d{1,2}):(\d{2})$/,
  new RegExp(`^${SPACE}(\\d{1,2}):(\\d{2})$`),
  new RegExp(`^${SPACE}(\\d{1,2})時(?:(\\d{1,2})分)?$`),
];

/** 日付だけ書いたときの起動時刻（JST） */
const DEFAULT_HOUR = 9;
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type RunAt =
  | { kind: 'none' }
  | { kind: 'valid'; at: Date }
  | { kind: 'invalid'; value: string };

/** 値の先頭から日付を読む。読めなければ undefined */
function readDate(
  value: string
): { year?: number; month: number; day: number; rest: string } | undefined {
  for (const { re, hasYear } of DATE_PATTERNS) {
    const m = re.exec(value);
    if (!m) continue;
    const rest = value.slice(m[0].length);
    return hasYear
      ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), rest }
      : { month: Number(m[1]), day: Number(m[2]), rest };
  }
  return undefined;
}

/** 日付のあとの時刻を読む。なければ 09:00、読めなければ undefined */
function readTime(rest: string): { hour: number; minute: number } | undefined {
  if (rest === '') return { hour: DEFAULT_HOUR, minute: 0 };
  for (const re of TIME_PATTERNS) {
    const m = re.exec(rest);
    if (m) return { hour: Number(m[1]), minute: m[2] === undefined ? 0 : Number(m[2]) };
  }
  return undefined;
}

/** 年を省いた日付の年。issue を作った日（JST）以降で最初に来るその日付にする */
function inferYear(
  month: number,
  day: number,
  createdAt: Date | string | undefined
): number | undefined {
  if (createdAt === undefined) return undefined;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return undefined;
  const jst = new Date(created.getTime() + JST_OFFSET_MS);
  const [cy, cm, cd] = [jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate()];
  return Date.UTC(cy, month - 1, day) >= Date.UTC(cy, cm - 1, cd) ? cy : cy + 1;
}

/**
 * 本文から起動日時を読む。行がなければ none、値を読めなければ invalid
 * @param createdAt issue を作った日時。年を省いた日付の年を決めるのに使う
 */
export function parseRunAt(body: string, createdAt?: Date | string): RunAt {
  const line = RUN_AT_LINE.exec(body);
  if (!line) return { kind: 'none' };
  const value = line[1];
  const invalid: RunAt = { kind: 'invalid', value };
  const date = readDate(value);
  if (!date) return invalid;
  const time = readTime(date.rest);
  if (!time || time.hour > 23 || time.minute > 59) return invalid;
  const year = date.year ?? inferYear(date.month, date.day, createdAt);
  if (year === undefined) return invalid;
  const { month, day } = date;
  const utc = Date.UTC(year, month - 1, day, time.hour, time.minute);
  // 2026-02-30 のような存在しない日は Date.UTC が翌月に繰り上げるので、戻して比べる
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return invalid;
  }
  return { kind: 'valid', at: new Date(utc - JST_OFFSET_MS) };
}
