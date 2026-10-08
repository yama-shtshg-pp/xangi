import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventStore, type AgentEvent } from '../src/event-store.js';

function makeEvent(id: string): AgentEvent {
  return {
    source: 'github-issue',
    id,
    title: `title ${id}`,
    body: 'body',
    url: `https://github.com/${id}`,
    labels: ['agent'],
  };
}

describe('EventStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-'));
    path = join(dir, 'events.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('同じイベントは 2 回キューに積まない', () => {
    const store = new EventStore(path);
    expect(store.enqueue(makeEvent('o/r#1'))).toBe(true);
    expect(store.enqueue(makeEvent('o/r#1'))).toBe(false);
    expect(store.countByStatus('queued')).toBe(1);
  });

  it('リポジトリ名の大文字・小文字が違っても同じイベントとみなす（読み直したあとも）', () => {
    const store = new EventStore(path);
    store.enqueue(makeEvent('O/My-Repo#1'));
    store.setStatus(makeEvent('o/my-repo#1'), 'done');
    expect(store.countByStatus('done')).toBe(1);
    expect(new EventStore(path).enqueue(makeEvent('o/my-repo#1'))).toBe(false);
  });

  it('完了したイベントも再び受け付けない', () => {
    const store = new EventStore(path);
    const event = makeEvent('o/r#1');
    store.enqueue(event);
    store.setStatus(event, 'done');
    expect(store.enqueue(event)).toBe(false);
  });

  it('再起動（読み直し）後も記録が残り、同じイベントを受け付けない', () => {
    const event = makeEvent('o/r#1');
    new EventStore(path).enqueue(event);
    const reloaded = new EventStore(path);
    expect(reloaded.has(event)).toBe(true);
    expect(reloaded.enqueue(event)).toBe(false);
  });

  it('同じ時刻に受け付けたイベントは積んだ順に返す', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    const store = new EventStore(path);
    store.enqueue(makeEvent('o/r#1'));
    store.enqueue(makeEvent('o/r#2'));
    expect(store.nextQueued()?.event.id).toBe('o/r#1');
  });

  it('キューは受け付けの古い順に返す', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new EventStore(path);
    vi.setSystemTime(new Date('2026-10-07T00:00:02Z'));
    store.enqueue(makeEvent('o/r#2'));
    vi.setSystemTime(new Date('2026-10-07T00:00:01Z'));
    store.enqueue(makeEvent('o/r#1'));
    expect(store.nextQueued()?.event.id).toBe('o/r#1');
    store.setStatus(makeEvent('o/r#1'), 'running');
    expect(store.nextQueued()?.event.id).toBe('o/r#2');
  });

  it('失敗の理由を残し、別の状態にしたら消す', () => {
    const store = new EventStore(path);
    const event = makeEvent('o/r#1');
    store.enqueue(event);
    store.setStatus(event, 'failed', 'boom');
    expect(new EventStore(path).nextQueued()).toBeUndefined();
    store.setStatus(event, 'done');
    expect(store.countByStatus('failed')).toBe(0);
  });

  it('起動中にしたイベントは tmux のセッション名を残し、読み直しても消えない', () => {
    const event = makeEvent('o/r#1');
    const store = new EventStore(path);
    store.enqueue(event);
    store.setRunning(event, 'cc-r-issue1');

    const reloaded = new EventStore(path);
    const running = reloaded.listByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0].sessionName).toBe('cc-r-issue1');
    expect(reloaded.nextQueued()).toBeUndefined();
  });

  it('壊れたファイルは空から始めずに例外を投げ、ファイルには触らない', () => {
    writeFileSync(path, '{broken');
    expect(() => new EventStore(path)).toThrow(/Failed to read/);
    expect(readFileSync(path, 'utf-8')).toBe('{broken');
    expect(readdirSync(dir)).toEqual(['events.json']);
  });
});
