import { describe, it, expect } from 'vitest';
import { routeModel } from '../src/router.js';

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
