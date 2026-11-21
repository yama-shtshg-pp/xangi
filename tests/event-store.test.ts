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

  it('needs_info のイベントは、タイトルか本文が変わったときだけ新しい内容でキューに積み直す', () => {
    const store = new EventStore(path);
    const event = makeEvent('o/r#1');
    store.enqueue(event);
    store.setStatus(event, 'needs_info', 'not ready');
    expect(store.requeueIfUpdated(event)).toBe(false);

    const updated = { ...event, body: 'more' };
    expect(store.requeueIfUpdated(updated)).toBe(true);
    const reloaded = new EventStore(path);
    expect(reloaded.nextQueued()?.event.body).toBe('more');
    expect(reloaded.nextQueued()?.error).toBeUndefined();
  });

  it('needs_info 以外のイベントは、内容が変わっても積み直さない', () => {
    const store = new EventStore(path);
    const event = makeEvent('o/r#1');
    store.enqueue(event);
    store.setStatus(event, 'done');
    expect(store.requeueIfUpdated({ ...event, body: 'more' })).toBe(false);
    expect(store.requeueIfUpdated(makeEvent('o/r#2'))).toBe(false);
  });

  describe('done のイベントの xangi-run-at の書き換え', () => {
    const withRunAt = (value: string): AgentEvent => ({
      ...makeEvent('o/r#1'),
      body: `本文\nxangi-run-at: ${value}`,
    });

    it('積んだときの日時を記録し、読み直しても残る。行がなければ null', () => {
      const store = new EventStore(path);
      store.enqueue(withRunAt('2026-11-10'));
      store.enqueue(makeEvent('o/r#2'));
      const reloaded = new EventStore(path);
      const [first, second] = reloaded.listByStatus('queued');
      expect(first.runAt).toBe('2026-11-10T00:00:00.000Z');
      expect(second.runAt).toBeNull();
    });

    it('日時が変わったら、新しい内容でキューに積み直し、新しい日時を記録する', () => {
      const store = new EventStore(path);
      store.enqueue(withRunAt('2026-11-10'));
      store.setStatus(makeEvent('o/r#1'), 'done');
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-17T14:00'))).toBe(true);
      const record = new EventStore(path).nextQueued();
      expect(record?.event.body).toContain('2026-11-17T14:00');
      expect(record?.runAt).toBe('2026-11-17T05:00:00.000Z');
    });

    it('積み直したイベントは、積み直した時刻でキューに並ぶ', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
      const store = new EventStore(path);
      store.enqueue(withRunAt('2026-11-10'));
      store.setStatus(makeEvent('o/r#1'), 'done');
      vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
      store.enqueue(makeEvent('o/r#2'));
      vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
      store.requeueIfRunAtChanged(withRunAt('2026-11-17'));
      expect(store.nextQueued()?.event.id).toBe('o/r#2');
    });

    it('同じ日時・行がない・読めない値なら積み直さない', () => {
      const store = new EventStore(path);
      store.enqueue(withRunAt('2026-11-10'));
      store.setStatus(makeEvent('o/r#1'), 'done');
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-10T09:00'))).toBe(false);
      expect(store.requeueIfRunAtChanged({ ...makeEvent('o/r#1'), body: '直した' })).toBe(false);
      expect(store.requeueIfRunAtChanged(withRunAt('2026/11/17'))).toBe(false);
      expect(store.countByStatus('done')).toBe(1);
      // 行を消しても、前回の日時は残す（もう一度同じ日時を書いても起動しない）
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-10'))).toBe(false);
    });

    it.each(['queued', 'running', 'failed', 'interrupted', 'needs_info'] as const)(
      '%s のイベントは日時が変わっても積み直さない',
      (status) => {
        const store = new EventStore(path);
        store.enqueue(withRunAt('2026-11-10'));
        store.setStatus(makeEvent('o/r#1'), status);
        expect(store.requeueIfRunAtChanged(withRunAt('2026-11-17'))).toBe(false);
        expect(store.listByStatus(status)[0].runAt).toBe('2026-11-10T00:00:00.000Z');
      }
    );

    it('記録のないイベントは積み直さない', () => {
      expect(new EventStore(path).requeueIfRunAtChanged(withRunAt('2026-11-17'))).toBe(false);
    });

    it('needs_info を積み直したときも、新しい本文の日時を記録する', () => {
      const store = new EventStore(path);
      store.enqueue(makeEvent('o/r#1'));
      store.setStatus(makeEvent('o/r#1'), 'needs_info');
      expect(store.requeueIfUpdated(withRunAt('2026-11-17'))).toBe(true);
      expect(store.nextQueued()?.runAt).toBe('2026-11-17T00:00:00.000Z');
    });

    it('日時を持たない古い記録は、今の値を前回の値として残し、その値では起動しない', () => {
      const old = {
        event: makeEvent('o/r#1'),
        status: 'done',
        receivedAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        sessionName: 'cc-r-issue1',
      };
      writeFileSync(path, JSON.stringify({ records: [old] }));
      const store = new EventStore(path);
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-10'))).toBe(false);
      expect(new EventStore(path).listByStatus('done')[0].runAt).toBe('2026-11-10T00:00:00.000Z');
      // そのあと書き換えれば積み直す
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-17'))).toBe(true);
    });

    it('日時を持たない古い記録で行がなければ null を残し、あとから書いた日時で積み直す', () => {
      const old = {
        event: makeEvent('o/r#1'),
        status: 'done',
        receivedAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      };
      writeFileSync(path, JSON.stringify({ records: [old] }));
      const store = new EventStore(path);
      expect(store.requeueIfRunAtChanged(makeEvent('o/r#1'))).toBe(false);
      expect(store.listByStatus('done')[0].runAt).toBeNull();
      expect(store.requeueIfRunAtChanged(withRunAt('2026-11-10'))).toBe(true);
    });
  });

  describe('新しい書き方の xangi-run-at（createdAt を使う）', () => {
    it('年を省いた日付の記録と書き換えの判定に、イベントの createdAt を使う', () => {
      const store = new EventStore(path);
      const base = {
        ...makeEvent('o/r#1'),
        createdAt: '2026-11-01T00:00:00Z',
      };
      store.enqueue({ ...base, body: '起動: 11/10' });
      expect(store.nextQueued()?.runAt).toBe('2026-11-10T00:00:00.000Z');
      store.setStatus(base, 'done');
      expect(store.requeueIfRunAtChanged({ ...base, body: '起動: 11/10 9時' })).toBe(false);
      expect(store.requeueIfRunAtChanged({ ...base, body: '起動日：11月17日' })).toBe(true);
      expect(store.nextQueued()?.runAt).toBe('2026-11-17T00:00:00.000Z');
    });

    it('createdAt のない古い記録でも壊れず、年を省いた日付は null になる', () => {
      const store = new EventStore(path);
      const event = { ...makeEvent('o/r#1'), body: '起動: 11/10' };
      expect(() => store.enqueue(event)).not.toThrow();
      expect(store.nextQueued()?.runAt).toBeNull();
    });
  });

  describe('読めない値のコメントの記録', () => {
    const event = makeEvent('o/r#1');

    it('記録がなければ undefined。記録した値を、読み直しても返す', () => {
      const store = new EventStore(path);
      expect(store.invalidSpecCommented(event, 'runAt')).toBeUndefined();
      store.recordInvalidSpecComment(event, 'runAt', 'あした');
      expect(store.invalidSpecCommented(event, 'runAt')).toBe('あした');
      expect(store.invalidSpecCommented(event, 'runAfter')).toBeUndefined();
      expect(new EventStore(path).invalidSpecCommented(event, 'runAt')).toBe('あした');
    });

    it('run-at と run-after は別に記録し、clear は指定した種類だけ消す', () => {
      const store = new EventStore(path);
      store.recordInvalidSpecComment(event, 'runAt', 'a');
      store.recordInvalidSpecComment(event, 'runAfter', 'b');
      store.clearInvalidSpecComment(event, 'runAt');
      const reloaded = new EventStore(path);
      expect(reloaded.invalidSpecCommented(event, 'runAt')).toBeUndefined();
      expect(reloaded.invalidSpecCommented(event, 'runAfter')).toBe('b');
    });

    it('リポジトリ名の大文字・小文字を区別しない', () => {
      const store = new EventStore(path);
      store.recordInvalidSpecComment(makeEvent('O/R#1'), 'runAt', 'a');
      expect(store.invalidSpecCommented(makeEvent('o/r#1'), 'runAt')).toBe('a');
    });

    it('records の読み書きを壊さず、records だけの古いファイルも読める', () => {
      writeFileSync(path, JSON.stringify({ records: [] }));
      const store = new EventStore(path);
      store.enqueue(event);
      store.recordInvalidSpecComment(event, 'runAt', 'a');
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { records: unknown[] };
      expect(raw.records).toHaveLength(1);
      expect(new EventStore(path).has(event)).toBe(true);
    });

    it('記録がないのに clear しても、ファイルを作らない', () => {
      new EventStore(path).clearInvalidSpecComment(event, 'runAt');
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it('壊れたファイルは空から始めずに例外を投げ、ファイルには触らない', () => {
    writeFileSync(path, '{broken');
    expect(() => new EventStore(path)).toThrow(/Failed to read/);
    expect(readFileSync(path, 'utf-8')).toBe('{broken');
    expect(readdirSync(dir)).toEqual(['events.json']);
  });
});
