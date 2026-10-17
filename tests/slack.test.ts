import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleEventWake, isEventWakeChannel } from '../src/slack.js';

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
