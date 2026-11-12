import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ISSUE_ONLY_DM_REPLY,
  WAKE_CHANNEL_MENTION_REPLY,
  buildIssueConfirmBlocks,
  handleEventWake,
  isAllowedSlackUser,
  isEventWakeChannel,
  issueMentionReply,
  issueOnlyMessageReply,
  toThreadMessages,
} from '../src/slack.js';
import {
  ISSUE_CREATE_ACTION,
  decodeIssueRequest,
  type IssueRequest,
  type SlackIssueCreator,
} from '../src/slack-issue.js';

describe('handleEventWake', () => {
  let onWake: ReturnType<typeof vi.fn>;
  const wake = () => ({ channelId: 'C1', onWake });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    onWake = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('合図のチャンネルの Bot の投稿なら onWake を呼んで true を返す', () => {
    expect(handleEventWake({ channel: 'C1', bot_id: 'B1' }, wake(), ['U1'])).toBe(true);
    expect(
      handleEventWake({ channel: 'C1', subtype: 'bot_message', bot_id: 'B1' }, wake(), [])
    ).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it('許可したユーザーの投稿なら onWake を呼ぶ', () => {
    expect(handleEventWake({ channel: 'C1', user: 'U1' }, wake(), ['U1'])).toBe(true);
    expect(handleEventWake({ channel: 'C1', user: 'U9' }, wake(), ['*'])).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it('許可していないユーザーの投稿は、onWake を呼ばずに true を返す（AI にも渡さない）', () => {
    expect(handleEventWake({ channel: 'C1', user: 'U9' }, wake(), ['U1'])).toBe(true);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('編集・削除・参加などは、onWake を呼ばずに true を返す', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
      expect(handleEventWake({ channel: 'C1', subtype, bot_id: 'B1' }, wake(), ['*'])).toBe(true);
    }
    expect(onWake).not.toHaveBeenCalled();
  });

  it('ほかのチャンネルの投稿なら onWake を呼ばずに false を返す', () => {
    expect(handleEventWake({ channel: 'C2', bot_id: 'B1' }, wake(), ['*'])).toBe(false);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('合図のチャンネルを設定していなければ false を返す', () => {
    expect(handleEventWake({ channel: 'C1', bot_id: 'B1' }, undefined, ['*'])).toBe(false);
  });
});

describe('isEventWakeChannel', () => {
  it('合図のチャンネルかを返す', () => {
    const eventWake = { channelId: 'C1', onWake: () => {} };
    expect(isEventWakeChannel('C1', eventWake)).toBe(true);
    expect(isEventWakeChannel('C2', eventWake)).toBe(false);
    expect(isEventWakeChannel('C1', undefined)).toBe(false);
  });
});

describe('issueMentionReply', () => {
  // handle に渡るかだけを見るので、中身は使わない
  const creator = {} as SlackIssueCreator;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issue を立てる処理があれば、handle の返事をそのまま返す', async () => {
    const handle = vi.fn(async () => ({ text: 'o/a に issue を作りますか？' }));
    expect(await issueMentionReply(creator, false, handle)).toEqual({
      text: 'o/a に issue を作りますか？',
    });
    expect(handle).toHaveBeenCalledWith(creator);
  });

  it('処理を作れなかったときは、会話にせず理由を返す', async () => {
    const handle = vi.fn();
    const reply = await issueMentionReply('記録を読めません', false, handle);
    expect(reply.text).toBe('⚠️ issue を立てられません: 記録を読めません');
    expect(handle).not.toHaveBeenCalled();
  });

  it('合図のチャンネルでは、issue を立てないことを返す', async () => {
    const handle = vi.fn();
    expect((await issueMentionReply(creator, true, handle)).text).toBe(WAKE_CHANNEL_MENTION_REPLY);
    expect((await issueMentionReply('理由', true, handle)).text).toBe(WAKE_CHANNEL_MENTION_REPLY);
    expect(handle).not.toHaveBeenCalled();
  });

  it('handle が失敗したら、黙らずにエラーを返す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await issueMentionReply(creator, false, async () => {
      throw new Error('gh が見つかりません');
    });
    expect(reply.text).toBe('⚠️ issue を立てられませんでした: gh が見つかりません');
  });
});

describe('issueOnlyMessageReply', () => {
  it('許可したユーザーの DM には、チャンネルでメンションするよう案内する', () => {
    expect(issueOnlyMessageReply({ isDM: true, allowed: true })).toBe(ISSUE_ONLY_DM_REPLY);
  });

  it('許可していないユーザーの DM と、チャンネルの投稿には返事をしない', () => {
    expect(issueOnlyMessageReply({ isDM: true, allowed: false })).toBeUndefined();
    expect(issueOnlyMessageReply({ isDM: false, allowed: true })).toBeUndefined();
  });
});

describe('isAllowedSlackUser', () => {
  it('許可リストのユーザーか * なら許可し、それ以外とユーザー不明は許可しない', () => {
    expect(isAllowedSlackUser(['U1'], 'U1')).toBe(true);
    expect(isAllowedSlackUser(['*'], 'U9')).toBe(true);
    expect(isAllowedSlackUser(['*'], undefined)).toBe(true);
    expect(isAllowedSlackUser(['U1'], 'U9')).toBe(false);
    expect(isAllowedSlackUser(['U1'], undefined)).toBe(false);
    expect(isAllowedSlackUser(undefined, 'U1')).toBe(false);
  });
});

describe('buildIssueConfirmBlocks', () => {
  const request: IssueRequest = {
    key: '1',
    explicitKey: true,
    channel: 'C1',
    ts: '100.1',
    mentionTs: '100.5',
    inThread: true,
    title: '[Slack] t',
  };

  it('確認の文と「作る」のボタンだけを並べ、ボタンの値から依頼を読み戻せる', () => {
    const blocks = buildIssueConfirmBlocks('o/a に issue を作りますか？', request);
    expect(blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'o/a に issue を作りますか？' },
    });
    const elements = (blocks[1] as { elements: Array<{ action_id: string; value: string }> })
      .elements;
    expect(elements.map((e) => e.action_id)).toEqual([ISSUE_CREATE_ACTION]);
    for (const e of elements) expect(decodeIssueRequest(e.value)).toEqual(request);
  });
});

describe('toThreadMessages', () => {
  it('メンションまでのメッセージを古い順に並べ、xangi 自身の投稿を除き、ほかの Bot は残す', () => {
    const messages = toThreadMessages(
      [
        { ts: '100.3', user: 'U2', text: '昨日から' },
        { ts: '100.1', bot_id: 'B9', bot_profile: { name: 'Alert' }, text: 'Cron failed' },
        { ts: '100.2', bot_id: 'B0', user: 'UX', text: '前の確認' },
        { ts: '100.5', user: 'U1', text: '<@UX> 1' },
        { ts: '100.6', user: 'U2', text: 'メンションのあと' },
      ],
      '100.5',
      { userId: 'UX', botId: 'B0' }
    );
    expect(messages).toEqual([
      { ts: '100.1', author: 'Alert', text: 'Cron failed' },
      { ts: '100.3', author: '<@U2>', text: '昨日から' },
      { ts: '100.5', author: '<@U1>', text: '<@UX> 1' },
    ]);
  });

  it('ts の桁が違っても数として比べる', () => {
    const messages = toThreadMessages(
      [
        { ts: '99.9', user: 'U1', text: 'a' },
        { ts: '100.10', user: 'U1', text: 'b' },
      ],
      '100.10',
      {}
    );
    expect(messages.map((m) => m.text)).toEqual(['a', 'b']);
  });
});
