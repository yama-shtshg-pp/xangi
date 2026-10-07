/**
 * Jev（TypeSafe System One）の共通クライアントと JSONL ログ
 *
 * - API: POST https://api.typesafe.ai/v1/systemone
 * - Docs: https://docs.typesafe.ai/api.md
 *
 * Why:
 * Jev は判定だけを担当し、最終的な動作は呼び出し側のコードで決める。
 * 判定はあくまで補助なので、タイムアウト・API エラー・キー未設定のときも
 * 例外を投げず `ok: false` を返す（呼び出し側は既存の挙動に戻す = fail-open）。
 *
 * TYPESAFE_API_KEY は safe-env のホワイトリストに入れない（AI CLI に渡さない）。
 */
import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const DEFAULT_JEV_TIMEOUT_MS = 800;

type Instructions = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'noul'; instructions: Instructions; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: Instructions; criteria: Record<string, string> }
  | { type: 'score'; instructions: Instructions; criteria: string[] };

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  /** noul: Yes である確率（0〜1） */
  noul?: number;
  /** choice: 選ばれた選択肢のキー */
  choice?: string;
  /** choice / score: 選択肢・レベルごとの確率 */
  probabilities?: Record<string, number>;
  /** choice / score: 分布の集中度（0〜1） */
  confidence?: number;
  /** score: 確率で重み付けした位置 */
  score?: number;
}

export type JevResult =
  | {
      ok: true;
      model: string;
      answers: Record<string, JevAnswer>;
      latencyMs: number;
    }
  | { ok: false; error: string; latencyMs: number };

export interface JevRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  timeoutMs?: number;
}

/**
 * Jev を 1 回呼び出す。失敗しても例外は投げない。
 */
export async function callJev(request: JevRequest): Promise<JevResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'TYPESAFE_API_KEY is not set', latencyMs: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS);

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: request.state,
        questions: request.questions,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, latencyMs: elapsed() };
    }
    const body = (await res.json()) as { model?: string; answers?: Record<string, JevAnswer> };
    if (!body.answers) {
      return { ok: false, error: 'response has no answers', latencyMs: elapsed() };
    }
    return {
      ok: true,
      model: body.model ?? JEV_MODEL,
      answers: body.answers,
      latencyMs: elapsed(),
    };
  } catch (err) {
    const error = controller.signal.aborted
      ? 'timeout'
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, error, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * JSONL に 1 行追記する。ログ書き込みの失敗で本処理を止めない。
 */
export async function appendJevLog(path: string, record: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    console.warn(
      `[jev] Failed to write log ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
