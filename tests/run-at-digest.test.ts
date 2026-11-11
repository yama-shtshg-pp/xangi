import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '../src/event-store.js';
import { buildRunAtDigest, formatJst, sendRunAtDigest } from '../src/run-at-digest.js';

function issue(n: number, body: string, title = `issue ${n}`): AgentEvent {
  return {
    source: 'github-issue',
    id: `o/r#${n}`,
    title,
    body,
    url: `https://github.com/o/r/issues/${n}`,
    labels: ['agent'],
  };
}

/** 2026-11-16（月）09:00 JST */
const NOW = new Date('2026-11-16T00:00:00Z');

describe('formatJst', () => {
  it('JST の日時にする', () => {
    expect(formatJst(new Date('2026-11-19T23:30:00Z'))).toBe('2026-11-20（金）08:30');
  });
});

describe('buildRunAtDigest', () => {
  it('起動待ちも読めない issue もなければ undefined', () => {
    expect(buildRunAtDigest([issue(1, '本文だけ')], NOW)).toBeUndefined();
  });

  it('起動待ちの issue を起動日時の近い順に、日時ごとにまとめて並べる', () => {
    const message = buildRunAtDigest(
      [
        issue(1, 'xangi-run-at: 2026-12-01'),
        issue(2, 'xangi-run-at: 2026-11-20T14:00'),
        issue(3, 'なし'),
        issue(4, 'xangi-run-at: 2026-11-20T14:00'),
      ],
      NOW
    );
    expect(message).toBe(
      [
        '*起動日を待っている issue（3 件）*',
        '• 2026-11-20（金）14:00',
        '    ◦ <https://github.com/o/r/issues/2|issue 2> r#2',
        '    ◦ <https://github.com/o/r/issues/4|issue 4> r#4',
        '• 2026-12-01（火）09:00',
        '    ◦ <https://github.com/o/r/issues/1|issue 1> r#1',
      ].join('\n')
    );
  });

  it('起動日時を過ぎた issue は載せない（ちょうどの時刻も過ぎた扱い）', () => {
    expect(
      buildRunAtDigest(
        [issue(1, 'xangi-run-at: 2026-11-10'), issue(2, 'xangi-run-at: 2026-11-16')],
        NOW
      )
    ).toBeUndefined();
  });

  it('読めない issue を書かれた値と一緒に載せる', () => {
    const message = buildRunAtDigest(
      [issue(1, 'xangi-run-at: 2026-11-20'), issue(2, 'xangi-run-at: 2026/11/20')],
      NOW
    );
    expect(message).toBe(
      [
        '*起動日を待っている issue（1 件）*',
        '• 2026-11-20（金）09:00',
        '    ◦ <https://github.com/o/r/issues/1|issue 1> r#1',
        '',
        '*起動日を読めず、起動しない issue（1 件）*',
        '`xangi-run-at: YYYY-MM-DD` か `YYYY-MM-DDTHH:MM` に直すと起動します',
        '• <https://github.com/o/r/issues/2|issue 2> r#2（`2026/11/20`）',
      ].join('\n')
    );
  });

  it('値が空か、バッククォートしかないときは「値が空」と書く', () => {
    const message = buildRunAtDigest(
      [issue(1, 'xangi-run-at:'), issue(2, 'xangi-run-at: ``')],
      NOW
    );
    expect(message).toContain('|issue 1> r#1（値が空）');
    expect(message).toContain('|issue 2> r#2（値が空）');
  });

  it('読めない issue だけでも送る', () => {
    expect(buildRunAtDigest([issue(1, 'xangi-run-at: 来週')], NOW)).toContain(
      '*起動日を読めず、起動しない issue（1 件）*'
    );
  });

  it('タイトルと値の < > & を逃がし、値のバッククォートを外す', () => {
    const message = buildRunAtDigest(
      [
        issue(1, 'xangi-run-at: 2026-11-20', 'a <b> & c'),
        issue(2, 'xangi-run-at: `<x>`', '<!channel>'),
      ],
      NOW
    );
    expect(message).toContain('|a &lt;b&gt; &amp; c> r#1');
    expect(message).toContain('|&lt;!channel&gt;> r#2（`&lt;x&gt;`）');
  });
});

describe('sendRunAtDigest', () => {
  const fetched =
    (events: AgentEvent[], failedRepos: string[] = []) =>
    async () => ({
      events,
      failedRepos,
    });

  it('一覧があれば送る', async () => {
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      fetch: fetched([issue(1, 'xangi-run-at: 2026-11-20')]),
      send,
      now: () => NOW,
    });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain('r#1');
  });

  it('一覧がなければ送らない', async () => {
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      fetch: fetched([issue(1, '本文')]),
      send,
      now: () => NOW,
    });
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('issue を取れなかったリポジトリがあれば、ほかが 0 件でも送る', async () => {
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      fetch: fetched([], ['o/broken']),
      send,
      now: () => NOW,
    });
    expect(sent).toBe(true);
    expect(send.mock.calls[0][0]).toBe('*issue を取れなかったリポジトリ（1 件）*\n• o/broken');
  });

  it('対象の一覧を取れなければ、取れなかったことを送る', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      fetch: async () => {
        throw new Error('watch-repos.json <broken>');
      },
      send,
      now: () => NOW,
    });
    expect(sent).toBe(true);
    expect(send.mock.calls[0][0]).toBe(
      '*起動日を待っている issue の一覧を作れませんでした*\nwatch-repos.json &lt;broken&gt;'
    );
    error.mockRestore();
  });

  it('送れなければ投げる', async () => {
    await expect(
      sendRunAtDigest({
        fetch: fetched([issue(1, 'xangi-run-at: 2026-11-20')]),
        send: async () => {
          throw new Error('slack down');
        },
        now: () => NOW,
      })
    ).rejects.toThrow('slack down');
  });
});
