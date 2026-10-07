/**
 * メッセージ内容に応じた model 振り分け（Phase 1: 案 B 単独）
 *
 * 現状ルール:
 * - エラー検知 regex に当たれば 'opus'
 * - それ以外は undefined（= デフォルト model を維持）
 *
 * Why:
 * regex 前段ルーティングの第一弾。誤発火（過剰に Opus）は許容、
 * 漏れ（本当のエラーが Sonnet で雑処理）の方が損失大という思想。
 */

import { callJev, type JevQuestion } from './jev-client.js';

const ERROR_PATTERN = /Error|Exception|Traceback|エラー|失敗|落ちる|動かない|スタックトレース/i;

export type RoutedModel = 'opus';

export function routeModel(prompt: string): RoutedModel | undefined {
  if (ERROR_PATTERN.test(prompt)) return 'opus';
  return undefined;
}

// ---------------------------------------------------------------------------
// Jev（TypeSafe System One）によるルーティング判定（shadow mode で検証中）
// ---------------------------------------------------------------------------

export type JevRoutingMode = 'off' | 'shadow';

/**
 * JEV_ROUTING を読む。未設定・不明な値は 'off'。
 *
 * Why: 'on'（Jev の判定で実際に振り分ける）は shadow 運用の評価後に入れる。
 * それまでは誤って本番の振り分けが変わらないよう、'on' も 'off' 扱いにする。
 */
export function getJevRoutingMode(env: NodeJS.ProcessEnv = process.env): JevRoutingMode {
  const value = env.JEV_ROUTING?.trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  if (value && value !== 'off') {
    console.warn(`[router] JEV_ROUTING=${value} is not supported yet. Jev routing is off.`);
  }
  return 'off';
}

export type JevEffort = 'light' | 'normal' | 'hard';

/** 処理の重さ → model の対応 */
export const JEV_EFFORT_MODEL: Record<JevEffort, string> = {
  light: 'haiku',
  normal: 'sonnet',
  hard: 'opus',
};

/** 追問判定に使う直前の Opus とのやり取り */
export interface PreviousExchange {
  userMessage: string;
  assistantAnswer: string;
}

export interface JevRouting {
  ok: boolean;
  /** Jev が選んだ処理の重さ（失敗時は undefined） */
  effort?: JevEffort;
  /** effort に対応する model */
  model?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** 直前の回答への追問である確率（previous がないときは undefined） */
  followup?: number;
  jevModel?: string;
  latencyMs: number;
  error?: string;
}

/** state に入れるテキストの上限（長文の貼り付けで入力トークンが膨らむのを防ぐ） */
const STATE_TEXT_LIMIT = 2000;

function truncate(text: string, limit = STATE_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export const EFFORT_QUESTION: JevQuestion = {
  type: 'choice',
  instructions:
    '`message` はチャットで AI アシスタントに届いた依頼です。この依頼に応えるために必要な処理の重さを選んでください。',
  criteria: {
    light: '挨拶、雑談、短い質問への回答、簡単な確認など、すぐに答えられる軽い応答',
    normal: '文章の作成や要約、コードの説明、小さな修正など、通常の作業',
    hard: 'エラーの原因調査、デバッグ、設計の判断、複数ファイルにまたがる実装など、深い推論が必要な難しい作業',
  },
};

export const FOLLOWUP_QUESTION: JevQuestion = {
  type: 'noul',
  instructions:
    '`message` は、直前のやり取り `previous_exchange`（ユーザーの依頼とアシスタントの回答）の後に同じユーザーから届いた新しいメッセージです。このメッセージは、直前の回答への追問、または直前の回答の続きの作業の依頼ですか。',
  criteria: {
    true: '直前の回答の内容を前提にしている（もっと詳しく、それを修正して、その案で実装して、など）',
    false: '直前の回答とは関係のない、新しい話題や依頼',
  },
};

/**
 * Jev で処理の重さ（と、直前の Opus 応答があれば追問かどうか）を判定する。
 * 1 回の呼び出しで両方の質問を並列に評価する。失敗しても例外は投げない。
 */
export async function routeWithJev(
  prompt: string,
  previous?: PreviousExchange,
  timeoutMs?: number
): Promise<JevRouting> {
  const state: Record<string, unknown> = { message: truncate(prompt) };
  const questions: Record<string, JevQuestion> = { effort: EFFORT_QUESTION };
  if (previous) {
    state.previous_exchange = {
      user_message: truncate(previous.userMessage),
      assistant_answer: truncate(previous.assistantAnswer),
    };
    questions.followup = FOLLOWUP_QUESTION;
  }

  const res = await callJev({ state, questions, timeoutMs });
  if (!res.ok) {
    return { ok: false, latencyMs: res.latencyMs, error: res.error };
  }

  const effortAnswer = res.answers.effort;
  const effort = effortAnswer?.choice as JevEffort | undefined;
  if (!effort || !Object.hasOwn(JEV_EFFORT_MODEL, effort)) {
    return {
      ok: false,
      latencyMs: res.latencyMs,
      jevModel: res.model,
      error: `unexpected effort answer: ${String(effortAnswer?.choice)}`,
    };
  }

  return {
    ok: true,
    effort,
    model: JEV_EFFORT_MODEL[effort],
    confidence: effortAnswer.confidence,
    probabilities: effortAnswer.probabilities,
    followup: previous ? res.answers.followup?.noul : undefined,
    jevModel: res.model,
    latencyMs: res.latencyMs,
  };
}
