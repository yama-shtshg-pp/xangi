import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callJev, appendJevLog, JEV_ENDPOINT, JEV_MODEL } from '../src/jev-client.js';

const request = {
  state: { message: 'こんにちは' },
  questions: {
    q: { type: 'noul' as const, instructions: 'これは挨拶ですか' },
  },
};

describe('callJev', () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalKey;
  });

  it('キー未設定なら API を呼ばずに ok: false を返す', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const res = await callJev(request);
    expect(res).toEqual({ ok: false, error: 'TYPESAFE_API_KEY is not set', latencyMs: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('エンドポイントに Bearer 認証と model・state・questions を送る', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } })
      )
    );
    const res = await callJev(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({
      model: JEV_MODEL,
      state: request.state,
      questions: request.questions,
    });
    expect(res).toMatchObject({
      ok: true,
      model: 'jev-1.13.0',
      answers: { q: { type: 'noul', noul: 0.9 } },
    });
  });

  it('HTTP エラーは ok: false（例外を投げない）', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const res = await callJev(request);
    expect(res).toMatchObject({ ok: false, error: 'HTTP 429' });
  });

  it('answers がない応答は ok: false', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: 'jev-1.13.0' })));
    const res = await callJev(request);
    expect(res).toMatchObject({ ok: false, error: 'response has no answers' });
  });

  it('ネットワークエラーは ok: false', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await callJev(request);
    expect(res).toMatchObject({ ok: false, error: 'ECONNRESET' });
  });

  it('タイムアウトしたら中断して error: timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const promise = callJev({ ...request, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
  });
});

describe('appendJevLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jev-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ディレクトリを作って 1 行 1 レコードで追記する', async () => {
    const path = join(dir, 'logs', 'jev-routing.jsonl');
    await appendJevLog(path, { a: 1 });
    await appendJevLog(path, { b: 'x' });
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 'x' }]);
  });

  it('書き込みに失敗しても例外を投げない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ファイルをディレクトリとして扱わせて失敗させる
    const file = join(dir, 'file');
    await appendJevLog(file, { a: 1 });
    await expect(appendJevLog(join(file, 'nested.jsonl'), { a: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
