import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'os';
import {
  SUMMARY_TITLE_LIMIT,
  cleanTitle,
  createClaudeTitleSummarizer,
} from '../src/title-summarizer.js';

describe('cleanTitle', () => {
  it('最初の空でない行を取り、引用符や見出し記号、前置きを外す', () => {
    expect(cleanTitle('\n「番組 Cron の失敗」\n説明')).toBe('番組 Cron の失敗');
    expect(cleanTitle('# タイトル: Cron   失敗')).toBe('Cron 失敗');
  });

  it('空なら undefined', () => {
    expect(cleanTitle('  \n ')).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
  });

  it('長すぎるタイトルは切り詰める', () => {
    const title = cleanTitle('あ'.repeat(100))!;
    expect(title).toHaveLength(SUMMARY_TITLE_LIMIT);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('createClaudeTitleSummarizer', () => {
  it('ツールと MCP を使わせない非対話モードで、一時ディレクトリから呼ぶ', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'Cron の失敗\n', stderr: '' });
    const summarize = createClaudeTitleSummarizer('/bin/claude', exec);

    expect(await summarize('  Cron failed  ')).toBe('Cron の失敗');

    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe('/bin/claude');
    expect(args.slice(0, 7)).toEqual([
      '-p',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]);
    expect(args.at(-1)).toBe('Cron failed');
    expect(options.cwd).toBe(tmpdir());
  });

  it('本文が - で始まっても、-- のあとに渡してオプションとして読ませない', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 't', stderr: '' });
    await createClaudeTitleSummarizer('/bin/claude', exec)('--dangerously-skip-permissions');
    const args = exec.mock.calls[0][1] as string[];
    expect(args.slice(-2)).toEqual(['--', '--dangerously-skip-permissions']);
  });

  it('シークレットの環境変数は渡さない', async () => {
    process.env.SLACK_BOT_TOKEN_TEST_DUMMY = 'x';
    const exec = vi.fn().mockResolvedValue({ stdout: 't', stderr: '' });
    await createClaudeTitleSummarizer('/bin/claude', exec)('text');
    expect(exec.mock.calls[0][2].env.SLACK_BOT_TOKEN_TEST_DUMMY).toBeUndefined();
    delete process.env.SLACK_BOT_TOKEN_TEST_DUMMY;
  });

  it('本文が空なら呼ばない', async () => {
    const exec = vi.fn();
    expect(await createClaudeTitleSummarizer('/bin/claude', exec)('  ')).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});
