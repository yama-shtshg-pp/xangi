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

const ERROR_PATTERN = /Error|Exception|Traceback|エラー|失敗|落ちる|動かない|スタックトレース/i;

export type RoutedModel = 'opus';

export function routeModel(prompt: string): RoutedModel | undefined {
  if (ERROR_PATTERN.test(prompt)) return 'opus';
  return undefined;
}
