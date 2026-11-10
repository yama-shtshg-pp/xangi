import { describe, it, expect, vi } from 'vitest';
import type { EventSource } from '../src/event-source-github.js';
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
    expect(formatJst(new Date('2026-11-19T23:30:00Z'))).toBe('2026-11-20 08:30');
  });
});

describe('buildRunAtDigest', () => {
  it('起動待ちも読めない issue もなければ undefined', () => {
    expect(buildRunAtDigest([issue(1, '本文だけ')], NOW)).toBeUndefined();
  });

  it('起動待ちの issue を起動日時の近い順に並べる', () => {
    const message = buildRunAtDigest(
      [
        issue(1, 'xangi-run-at: 2026-12-01'),
        issue(2, 'xangi-run-at: 2026-11-20T14:00'),
        issue(3, 'なし'),
      ],
      NOW
    );
    expect(message).toBe(
      [
        '*起動日を待っている issue（2 件）*',
        '• 2026-11-20 14:00 <https://github.com/o/r/issues/2|o/r#2> issue 2',
        '• 2026-12-01 09:00 <https://github.com/o/r/issues/1|o/r#1> issue 1',
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
        '• 2026-11-20 09:00 <https://github.com/o/r/issues/1|o/r#1> issue 1',
        '',
        '*起動日を読めず、起動しない issue（1 件）*',
        '`xangi-run-at: YYYY-MM-DD` か `YYYY-MM-DDTHH:MM` に直すと起動します',
        '• <https://github.com/o/r/issues/2|o/r#2> issue 2（`2026/11/20`）',
      ].join('\n')
    );
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
    expect(message).toContain('o/r#1> a &lt;b&gt; &amp; c');
    expect(message).toContain('o/r#2> &lt;!channel&gt;（`&lt;x&gt;`）');
  });
});

describe('sendRunAtDigest', () => {
  const source = (events: AgentEvent[] | Error, name = 'github-issue'): EventSource => ({
    name,
    poll: async () => {
      if (events instanceof Error) throw events;
      return events;
    },
  });

  it('一覧があれば送る', async () => {
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      sources: [source([issue(1, 'xangi-run-at: 2026-11-20')])],
      send,
      now: () => NOW,
    });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toContain('o/r#1');
  });

  it('一覧がなければ送らない', async () => {
    const send = vi.fn(async () => {});
    const sent = await sendRunAtDigest({
      sources: [source([issue(1, '本文')])],
      send,
      now: () => NOW,
    });
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('1 つの源が失敗しても、ほかの源の一覧は送る', async () => {
    const send = vi.fn(async () => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sent = await sendRunAtDigest({
      sources: [
        source(new Error('boom'), 'broken'),
        source([issue(1, 'xangi-run-at: 2026-11-20')]),
      ],
      send,
      now: () => NOW,
    });
    expect(sent).toBe(true);
    expect(send.mock.calls[0][0]).toContain('o/r#1');
  });

  it('送れなければ投げる', async () => {
    await expect(
      sendRunAtDigest({
        sources: [source([issue(1, 'xangi-run-at: 2026-11-20')])],
        send: async () => {
          throw new Error('slack down');
        },
        now: () => NOW,
      })
    ).rejects.toThrow('slack down');
  });
});
