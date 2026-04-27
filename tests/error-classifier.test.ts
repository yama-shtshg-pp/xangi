import { describe, it, expect } from 'vitest';
import { classifyAgentError } from '../src/error-classifier.js';

describe('classifyAgentError', () => {
  const TIMEOUT_MS = 300000;

  describe('Prompt is too long (context limit)', () => {
    it('should mark session for reset and skip follow-up', () => {
      const result = classifyAgentError('API Error: 400 Prompt is too long', TIMEOUT_MS);
      expect(result.shouldResetSession).toBe(true);
      expect(result.shouldFollowUp).toBe(false);
      expect(result.display).toContain('コンテキストが上限');
      expect(result.display).toContain('/new');
    });

    it('should match even when surrounded by other text', () => {
      const msg = 'Error: messages.0.content: Prompt is too long: 250000 tokens';
      const result = classifyAgentError(msg, TIMEOUT_MS);
      expect(result.shouldResetSession).toBe(true);
    });
  });

  describe('timeout', () => {
    it('should suppress follow-up but keep session', () => {
      const result = classifyAgentError('Process timed out after 300s', TIMEOUT_MS);
      expect(result.shouldFollowUp).toBe(false);
      expect(result.shouldResetSession).toBe(false);
      expect(result.display).toContain('300秒');
    });

    it('should round timeout seconds based on provided ms', () => {
      const result = classifyAgentError('timed out', 60500);
      expect(result.display).toContain('61秒');
    });
  });

  describe('Process exited unexpectedly', () => {
    it('should allow follow-up to recover partial state', () => {
      const result = classifyAgentError('Process exited unexpectedly with code 1', TIMEOUT_MS);
      expect(result.shouldFollowUp).toBe(true);
      expect(result.shouldResetSession).toBe(false);
      expect(result.display).toContain('予期せず終了');
    });
  });

  describe('Circuit breaker', () => {
    it('should suppress follow-up to avoid extending channel lock', () => {
      const result = classifyAgentError('Circuit breaker is OPEN', TIMEOUT_MS);
      expect(result.shouldFollowUp).toBe(false);
      expect(result.shouldResetSession).toBe(false);
      expect(result.display).toContain('一時停止');
    });
  });

  describe('unknown error', () => {
    it('should follow up by default and truncate to 200 chars', () => {
      const long = 'x'.repeat(500);
      const result = classifyAgentError(long, TIMEOUT_MS);
      expect(result.shouldFollowUp).toBe(true);
      expect(result.shouldResetSession).toBe(false);
      expect(result.display.length).toBeLessThanOrEqual(200 + '❌ エラーが発生しました: '.length);
    });
  });

  describe('priority of context-limit', () => {
    it('should treat Prompt-is-too-long as context-limit even if other keywords are present', () => {
      const result = classifyAgentError(
        'Process exited unexpectedly: Prompt is too long',
        TIMEOUT_MS
      );
      expect(result.shouldResetSession).toBe(true);
      expect(result.shouldFollowUp).toBe(false);
    });
  });
});
