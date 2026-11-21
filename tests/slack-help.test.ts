import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildHelpText,
  findHelpWordKeys,
  getJevHelpMode,
  HELP_THRESHOLD,
  HelpChecker,
  isHelpWord,
  judgeHelpRequest,
  type HelpJudgement,
} from '../src/slack-help.js';
import { JEV_ENDPOINT } from '../src/jev-client.js';

describe('getJevHelpMode', () => {
  it('未設定は off、shadow・on はそのまま、不明な値は off（警告つき）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getJevHelpMode({})).toBe('off');
    expect(getJevHelpMode({ JEV_HELP: 'shadow' })).toBe('shadow');
    expect(getJevHelpMode({ JEV_HELP: ' ON ' })).toBe('on');
    expect(warn).not.toHaveBeenCalled();
    expect(getJevHelpMode({ JEV_HELP: 'yes' })).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('isHelpWord', () => {
  it.each(['使い方', 'ヘルプ', 'help', '?', '？'])('%s は決まった言葉', (word) => {
    expect(isHelpWord(word)).toBe(true);
  });

  it('前後の空白、大文字・小文字、末尾の ? / ？ は区別しない', () => {
    expect(isHelpWord('  help  ')).toBe(true);
    expect(isHelpWord('HELP')).toBe(true);
    expect(isHelpWord('Help?')).toBe(true);
    expect(isHelpWord('help？')).toBe(true);
    expect(isHelpWord('使い方？')).toBe(true);
    expect(isHelpWord('\n使い方\n')).toBe(true);
  });

  it('ほかの語が付いたら決まった言葉ではない', () => {
    expect(isHelpWord('')).toBe(false);
    expect(isHelpWord('help me')).toBe(false);
    expect(isHelpWord('1 help')).toBe(false);
    expect(isHelpWord('使い方を教えて')).toBe(false);
    expect(isHelpWord('helper')).toBe(false);
  });
});

describe('buildHelpText', () => {
  it('早見表の全文を固定する', () => {
    expect(buildHelpText('- `1` o/a\n- `jra` o/b')).toBe(
      [
        '*xangi の使い方*',
        'issue に `agent` ラベルを付けると、Claude Code が起動します',
        '- 起動する日: 本文の行頭に `起動: 11/20 14時`（`xangi-run-at: 2026-11-20T14:00` も可）',
        '- 前の issue を待つ: 本文の行頭に `待つ: #12, repo#3, issue の URL`',
        '  - GitHub の「Blocked by」に指定した issue も待ちます',
        '- Slack から issue を立てる: `@xangi &lt;key&gt; 内容`',
        '  - スレッドの中なら `@xangi &lt;key&gt;` だけで、スレッドのやり取りを issue にします',
        '詳しい説明: <https://github.com/yama-shtshg-pp/xangi/blob/main/docs/usage.md#%E8%B5%B7%E5%8B%95%E3%81%99%E3%82%8B%E6%97%A5%E3%82%92%E6%8C%87%E5%AE%9A%E3%81%99%E3%82%8B|起動する日> / <https://github.com/yama-shtshg-pp/xangi/blob/main/docs/usage.md#%E5%85%88%E3%81%AB%E7%B5%82%E3%82%8F%E3%82%89%E3%81%9B%E3%82%8B-issue-%E3%82%92%E6%8C%87%E5%AE%9A%E3%81%99%E3%82%8B|前の issue を待つ> / <https://github.com/yama-shtshg-pp/xangi/blob/main/docs/usage.md#slack-%E3%81%AE%E3%83%A1%E3%83%B3%E3%82%B7%E3%83%A7%E3%83%B3%E3%81%8B%E3%82%89-issue-%E3%82%92%E7%AB%8B%E3%81%A6%E3%82%8B|Slack から立てる>',
        'key の一覧',
        '- `1` o/a',
        '- `jra` o/b',
      ].join('\n')
    );
  });

  it('key の一覧を除いて 15 行以内', () => {
    const text = buildHelpText('KEYS');
    const lines = text.split('\n');
    expect(lines.length - 2).toBeLessThanOrEqual(15);
    expect(lines.at(-1)).toBe('KEYS');
  });
});

describe('findHelpWordKeys', () => {
  it('決まった言葉と同じ key（normalizeKey で比べる）を返す', () => {
    const targets = [
      { repo: 'o/a', label: 'agent', key: '1' },
      { repo: 'o/b', label: 'agent', key: 'Help' },
      { repo: 'o/c', label: 'agent', key: '使い方' },
      { repo: 'o/d', label: 'agent' },
    ];
    expect(findHelpWordKeys(targets)).toEqual(['Help', '使い方']);
  });

  it('該当がなければ空', () => {
    expect(findHelpWordKeys([{ repo: 'o/a', label: 'agent', key: '1' }])).toEqual([]);
  });
});

describe('judgeHelpRequest', () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  function respond(answers: Record<string, unknown>) {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: 'jev-1', answers }), { status: 200 })
    );
  }

  it('メンションの文を noul の質問で 1 回聞く', async () => {
    respond({ help: { type: 'noul', noul: 0.9 } });
    const res = await judgeHelpRequest('起動日ってどう書くんだっけ');
    expect(fetchMock).toHaveBeenCalledWith(JEV_ENDPOINT, expect.anything());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state).toEqual({ text: '起動日ってどう書くんだっけ' });
    expect(Object.keys(sent.questions)).toEqual(['help']);
    expect(sent.questions.help.type).toBe('noul');
    expect(sent.questions.help.criteria.true).toEqual(expect.any(String));
    expect(sent.questions.help.criteria.false).toContain('不具合');
    expect(res).toMatchObject({ ok: true, help: 0.9, jevModel: 'jev-1' });
  });

  it('長い文は切り詰めて送る', async () => {
    respond({ help: { type: 'noul', noul: 0.1 } });
    await judgeHelpRequest('x'.repeat(10_000));
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.state.text.length).toBeLessThanOrEqual(2001);
  });

  it('help の答えがなければ ok: false', async () => {
    respond({});
    expect((await judgeHelpRequest('t')).ok).toBe(false);
  });

  it('キー未設定なら ok: false で、Jev を呼ばない', async () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(await judgeHelpRequest('t')).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HelpChecker', () => {
  let dir: string;
  let logPath: string;
  const input = { id: 'C1:100.1', text: '起動日ってどう書くんだっけ' };
  const asks: HelpJudgement = { ok: true, help: 0.9, latencyMs: 5, jevModel: 'jev-1' };
  const notAsks: HelpJudgement = { ok: true, help: 0.1, latencyMs: 5 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slack-help-'));
    logPath = join(dir, 'logs', 'jev-help.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLog = () =>
    readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  it('しきい値は 0 より大きく 1 未満の定数', () => {
    expect(HELP_THRESHOLD).toBeGreaterThan(0);
    expect(HELP_THRESHOLD).toBeLessThan(1);
  });

  it('off では Jev を呼ばず、ログも残さず、false を返す', async () => {
    const judge = vi.fn(async () => asks);
    const checker = new HelpChecker({ mode: 'off', logPath, judge });
    expect(await checker.check(input)).toBe(false);
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('on でしきい値以上なら true、未満なら false', async () => {
    const yes = new HelpChecker({ mode: 'on', logPath, judge: async () => asks });
    expect(await yes.check(input)).toBe(true);
    const edge = new HelpChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ok: true, help: HELP_THRESHOLD, latencyMs: 1 }),
    });
    expect(await edge.check(input)).toBe(true);
    const no = new HelpChecker({ mode: 'on', logPath, judge: async () => notAsks });
    expect(await no.check(input)).toBe(false);
  });

  it('shadow では判定を待たずに false を返し、結果をログに残す', async () => {
    let resolve!: (r: HelpJudgement) => void;
    const judge = vi.fn(() => new Promise<HelpJudgement>((r) => (resolve = r)));
    const checker = new HelpChecker({ mode: 'shadow', logPath, judge });
    expect(await checker.check(input)).toBe(false);
    resolve(asks);
    await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
    expect(readLog()[0]).toMatchObject({
      mode: 'shadow',
      id: 'C1:100.1',
      text: '起動日ってどう書くんだっけ',
      text_length: 13,
      help: 0.9,
      is_help: true,
      latency_ms: 5,
      error: null,
      jev_model: 'jev-1',
    });
  });

  it('ログの文は先頭 200 文字だけ残し、長さも残す', async () => {
    const checker = new HelpChecker({ mode: 'on', logPath, judge: async () => notAsks });
    await checker.check({ id: 'x', text: 'あ'.repeat(500) });
    const [row] = readLog();
    expect(row.text).toBe('あ'.repeat(200));
    expect(row.text_length).toBe(500);
  });

  it('on で Jev が失敗・例外を投げたら false（fail-open）で、理由をログに残す', async () => {
    const failing = new HelpChecker({
      mode: 'on',
      logPath,
      judge: async () => ({ ok: false, error: 'timeout', latencyMs: 800 }),
    });
    expect(await failing.check(input)).toBe(false);
    const throwing = new HelpChecker({
      mode: 'on',
      logPath,
      judge: async () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.check(input)).toBe(false);
    expect(readLog().map((r) => r.error)).toEqual(['timeout', 'boom']);
  });
});
