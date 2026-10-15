import { describe, it, expect, vi } from 'vitest';
import { handleEventWake } from '../src/slack.js';

describe('handleEventWake', () => {
  it('合図のチャンネルの投稿なら onWake を呼んで true を返す', () => {
    const onWake = vi.fn();
    expect(handleEventWake('C1', { channelId: 'C1', onWake })).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('ほかのチャンネルの投稿なら onWake を呼ばずに false を返す', () => {
    const onWake = vi.fn();
    expect(handleEventWake('C2', { channelId: 'C1', onWake })).toBe(false);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('合図のチャンネルを設定していなければ false を返す', () => {
    expect(handleEventWake('C1', undefined)).toBe(false);
  });
});
