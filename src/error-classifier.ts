/**
 * agentRunner.run / runStream が投げたエラーを分類し、
 * 表示文言と後処理（自動フォローアップ／セッションリセット）の方針を返す
 *
 * Why: 種類によって対処が真逆になる
 * - context-limit (`Prompt is too long`): 同じ providerSessionId で --resume すると
 *   累積コンテキストが API 上限を超えたまま再送され、永遠に同じエラーになる。
 *   セッションを破棄して次回入力で新規セッションを立てる必要がある
 * - timeout / Circuit breaker: 壊れたセッションに自動フォローアップを投げると
 *   さらに悪化（再タイムアウト→Circuit breaker でチャンネル長時間ロック）するため抑制
 */
export interface ClassifiedAgentError {
  /** ユーザー向け表示テキスト（emoji 込み、Discord/Slack そのまま貼る） */
  display: string;
  /** 自動フォローアップ（途中状況の問い合わせ）を送ってよいか */
  shouldFollowUp: boolean;
  /** チャンネルのアクティブセッションを破棄すべきか */
  shouldResetSession: boolean;
}

export function classifyAgentError(errorMsg: string, timeoutMs: number): ClassifiedAgentError {
  if (errorMsg.includes('Prompt is too long')) {
    return {
      display:
        '📦 セッションのコンテキストが上限に達しました。次のメッセージから新しいセッションが自動的に開始されます（手動でリセットするには `/new`）',
      shouldFollowUp: false,
      shouldResetSession: true,
    };
  }
  if (errorMsg.includes('timed out')) {
    return {
      display: `⏱️ タイムアウトしました（${Math.round(timeoutMs / 1000)}秒）`,
      shouldFollowUp: false,
      shouldResetSession: false,
    };
  }
  if (errorMsg.includes('Process exited unexpectedly')) {
    return {
      display: `💥 AIプロセスが予期せず終了しました: ${errorMsg}`,
      shouldFollowUp: true,
      shouldResetSession: false,
    };
  }
  if (errorMsg.includes('Circuit breaker')) {
    return {
      display:
        '🔌 AIプロセスが連続でクラッシュしたため一時停止中です。しばらくしてから再試行してください',
      shouldFollowUp: false,
      shouldResetSession: false,
    };
  }
  return {
    display: `❌ エラーが発生しました: ${errorMsg.slice(0, 200)}`,
    shouldFollowUp: true,
    shouldResetSession: false,
  };
}
