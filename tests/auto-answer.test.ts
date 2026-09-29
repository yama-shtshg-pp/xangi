import { describe, it, expect, vi } from 'vitest';
import {
  detectQuestionOrDefer,
  extractLastParagraph,
  buildAutoAnswerPrompt,
  runAutoAnswerLoop,
} from '../src/auto-answer.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../src/agent-runner.js';

describe('extractLastParagraph', () => {
  it('returns trimmed last paragraph block', () => {
    expect(extractLastParagraph('first\n\nlast line')).toBe('last line');
  });

  it('handles single paragraph', () => {
    expect(extractLastParagraph('only one')).toBe('only one');
  });

  it('returns empty for blank input', () => {
    expect(extractLastParagraph('   \n\n  ')).toBe('');
  });
});

describe('detectQuestionOrDefer', () => {
  describe('質問パターン（末尾 ?/？）', () => {
    it('全角 ？で終わる末尾段落を検出', () => {
      expect(detectQuestionOrDefer('実装完了しました。\n\n実装済みですか？')).toBe(true);
    });

    it('半角 ? で終わる末尾段落を検出', () => {
      expect(detectQuestionOrDefer('Done.\n\nReady to deploy?')).toBe(true);
    });

    it('末尾の空白を許容', () => {
      expect(detectQuestionOrDefer('実装済みですか？  \n')).toBe(true);
    });

    it('末尾段落以外の ? は無視（コードブロック内など）', () => {
      const text = '途中で `foo?` と書いた。\n\n完了しました。';
      expect(detectQuestionOrDefer(text)).toBe(false);
    });
  });

  describe('保留パターン', () => {
    it('「待ってください」を検出', () => {
      expect(detectQuestionOrDefer('レビューします。少し待ってください。')).toBe(true);
    });

    it('「お待ちください」を検出', () => {
      expect(detectQuestionOrDefer('確認中です。お待ちください。')).toBe(true);
    });

    it('「後ほど」を検出', () => {
      expect(detectQuestionOrDefer('後ほど結果をお伝えします。')).toBe(true);
    });

    it('作業動詞 + 「〜します。」末尾を検出', () => {
      expect(detectQuestionOrDefer('これらをレビューして結果を見せます。')).toBe(true);
    });

    it('作業動詞なしの「〜します」は誤検出しない', () => {
      // "対応します" だけでは保留と断定しない（false positive 抑止）
      expect(detectQuestionOrDefer('対応します。')).toBe(false);
    });
  });

  describe('通常完了パターン', () => {
    it('完了報告は false', () => {
      expect(detectQuestionOrDefer('修正をコミットしました。テストもパスしています。')).toBe(
        false
      );
    });

    it('空文字は false', () => {
      expect(detectQuestionOrDefer('')).toBe(false);
    });
  });
});

describe('buildAutoAnswerPrompt', () => {
  it('禁止指示と直前応答を含む', () => {
    const prompt = buildAutoAnswerPrompt('実装済みですか？');
    expect(prompt).toContain('質問・保留');
    expect(prompt).toContain('実装済みですか？');
  });
});

describe('runAutoAnswerLoop', () => {
  function makeRunner(responses: string[]): AgentRunner & { calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const runner: AgentRunner & { calls: string[] } = {
      calls,
      run: vi.fn(async (prompt: string, _options?: RunOptions): Promise<RunResult> => {
        calls.push(prompt);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return { result: r, sessionId: 'session-' + i };
      }),
      runStream: vi.fn(
        async (
          _prompt: string,
          _cb: StreamCallbacks,
          _opts?: RunOptions
        ): Promise<RunResult> => ({
          result: '',
          sessionId: '',
        })
      ),
    };
    return runner;
  }

  it('disabled の場合はループしない', async () => {
    const runner = makeRunner(['n/a']);
    const out = await runAutoAnswerLoop(
      runner,
      { result: '実装済みですか？', sessionId: 's0' },
      {},
      { enabled: false, maxTurns: 3 }
    );
    expect(out.turns).toBe(0);
    expect(out.result).toBe('実装済みですか？');
    expect(runner.calls).toHaveLength(0);
  });

  it('質問が消えるまで再実行', async () => {
    // 1ターン目: 解決して完了報告
    const runner = makeRunner(['実装を完了し、テストも通しました。']);
    const out = await runAutoAnswerLoop(
      runner,
      { result: '実装済みですか？', sessionId: 's0' },
      { channelId: 'c1' },
      { enabled: true, maxTurns: 3 }
    );
    expect(out.turns).toBe(1);
    expect(out.result).toContain('完了');
    expect(runner.calls).toHaveLength(1);
  });

  it('max-turns で打ち切り、最後の result を返す', async () => {
    const runner = makeRunner(['まだ確認しますか？', 'もう一度ですか？', 'まだですか？']);
    const out = await runAutoAnswerLoop(
      runner,
      { result: '初期質問ですか？', sessionId: 's0' },
      {},
      { enabled: true, maxTurns: 2 }
    );
    expect(out.turns).toBe(2);
    expect(runner.calls).toHaveLength(2);
    expect(out.result).toBe('もう一度ですか？');
  });

  it('同 sessionId を引き継ぐ', async () => {
    const runner = makeRunner(['完了しました。']);
    const out = await runAutoAnswerLoop(
      runner,
      { result: '実装済みですか？', sessionId: 'initial-session' },
      { channelId: 'c1', appSessionId: 'app1' },
      { enabled: true, maxTurns: 3 }
    );
    expect(out.turns).toBe(1);
    const runMock = runner.run as ReturnType<typeof vi.fn>;
    expect(runMock.mock.calls[0][1]).toMatchObject({
      sessionId: 'initial-session',
      channelId: 'c1',
      appSessionId: 'app1',
    });
  });
});
