import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  routeModel,
  routeWithJev,
  getJevRoutingMode,
  EFFORT_QUESTION,
  FOLLOWUP_QUESTION,
} from '../src/router.js';
import { callJev } from '../src/jev-client.js';

vi.mock('../src/jev-client.js', () => ({ callJev: vi.fn() }));
const callJevMock = vi.mocked(callJev);

describe('routeModel', () => {
  describe('ヒットケース（Opus に振り分け）', () => {
    const cases = [
      'Error: foo not defined',
      'TypeError: undefined is not a function',
      'Traceback (most recent call last):',
      'Exceptionが発生しました',
      'エラーが出ました',
      'ビルドが失敗します',
      'なぜか動かないです',
      'コンソールが落ちる',
      'スタックトレース貼ります',
    ];
    it.each(cases)('"%s" → opus', (input) => {
      expect(routeModel(input)).toBe('opus');
    });

    it('regex は大文字小文字を区別しない', () => {
      expect(routeModel('error: lowercase')).toBe('opus');
      expect(routeModel('ERROR: uppercase')).toBe('opus');
    });

    it('長文の中に埋もれていてもヒットする', () => {
      const longPrompt =
        'こんにちは。実装を進めていたのですが、突然 Error: cannot find module というメッセージが出て困っています。';
      expect(routeModel(longPrompt)).toBe('opus');
    });
  });

  describe('非ヒットケース（デフォルト維持）', () => {
    const cases = [
      'こんにちは',
      'リファクタリングを手伝って',
      'このコードの意味は？',
      'README を更新したい',
      '次のレース予想は？',
      'docs/design.md を読んでまとめて',
      '',
    ];
    it.each(cases)('"%s" → undefined', (input) => {
      expect(routeModel(input)).toBeUndefined();
    });
  });

  describe('既知の許容誤発火', () => {
    // Why: regex は荒い前段。誤発火（過剰に Opus）は許容、漏れの方が損失大の方針
    it('「失敗」を含む雑談文も Opus に振られる（許容）', () => {
      expect(routeModel('テスト失敗してるけど期待通り？')).toBe('opus');
    });
  });
});

describe('getJevRoutingMode', () => {
  it('未設定・off は off', () => {
    expect(getJevRoutingMode({})).toBe('off');
    expect(getJevRoutingMode({ JEV_ROUTING: 'off' })).toBe('off');
  });

  it('shadow は shadow（大文字小文字・前後空白を無視）', () => {
    expect(getJevRoutingMode({ JEV_ROUTING: 'shadow' })).toBe('shadow');
    expect(getJevRoutingMode({ JEV_ROUTING: ' Shadow ' })).toBe('shadow');
  });

  it('on は評価前なので off 扱い（警告を出す）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getJevRoutingMode({ JEV_ROUTING: 'on' })).toBe('off');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('routeWithJev', () => {
  beforeEach(() => {
    callJevMock.mockReset();
  });

  it('処理の重さを Choice で聞き、model に対応付ける', async () => {
    callJevMock.mockResolvedValue({
      ok: true,
      model: 'jev-1.13.0',
      latencyMs: 120,
      answers: {
        effort: {
          type: 'choice',
          choice: 'hard',
          confidence: 0.8,
          probabilities: { light: 0.05, normal: 0.15, hard: 0.8 },
        },
      },
    });

    const res = await routeWithJev('ビルドが通らない原因を調べて');

    expect(callJevMock).toHaveBeenCalledWith({
      state: { message: 'ビルドが通らない原因を調べて' },
      questions: { effort: EFFORT_QUESTION },
      timeoutMs: undefined,
    });
    expect(res).toEqual({
      ok: true,
      effort: 'hard',
      model: 'opus',
      confidence: 0.8,
      probabilities: { light: 0.05, normal: 0.15, hard: 0.8 },
      followup: undefined,
      jevModel: 'jev-1.13.0',
      latencyMs: 120,
    });
  });

  it('直前のやり取りがあれば追問判定も同じ呼び出しで聞く', async () => {
    callJevMock.mockResolvedValue({
      ok: true,
      model: 'jev-1.13.0',
      latencyMs: 150,
      answers: {
        effort: { type: 'choice', choice: 'light', confidence: 0.6 },
        followup: { type: 'noul', noul: 0.92 },
      },
    });

    const res = await routeWithJev('もっと詳しく', {
      userMessage: 'Error: foo',
      assistantAnswer: 'foo が未定義です',
    });

    const req = callJevMock.mock.calls[0][0];
    expect(req.state).toEqual({
      message: 'もっと詳しく',
      previous_exchange: { user_message: 'Error: foo', assistant_answer: 'foo が未定義です' },
    });
    expect(req.questions).toEqual({ effort: EFFORT_QUESTION, followup: FOLLOWUP_QUESTION });
    expect(res).toMatchObject({ ok: true, model: 'haiku', followup: 0.92 });
  });

  it('長文は state に入れる前に切り詰める', async () => {
    callJevMock.mockResolvedValue({ ok: false, error: 'timeout', latencyMs: 800 });
    await routeWithJev('a'.repeat(5000));
    const message = (callJevMock.mock.calls[0][0].state as { message: string }).message;
    expect(message.length).toBe(2001);
    expect(message.endsWith('…')).toBe(true);
  });

  it('API 失敗はそのまま ok: false で返す（例外を投げない）', async () => {
    callJevMock.mockResolvedValue({ ok: false, error: 'timeout', latencyMs: 800 });
    await expect(routeWithJev('こんにちは')).resolves.toEqual({
      ok: false,
      error: 'timeout',
      latencyMs: 800,
    });
  });

  it.each(['unknown', 'constructor'])('想定外の選択肢 %s が返ったら ok: false', async (choice) => {
    callJevMock.mockResolvedValue({
      ok: true,
      model: 'jev-1.13.0',
      latencyMs: 100,
      answers: { effort: { type: 'choice', choice } },
    });
    const res = await routeWithJev('こんにちは');
    expect(res).toMatchObject({ ok: false, error: `unexpected effort answer: ${choice}` });
  });
});
