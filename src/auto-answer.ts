import type { AgentRunner, RunOptions, RunResult } from './agent-runner.js';

export interface AutoAnswerConfig {
  enabled: boolean;
  maxTurns: number;
}

const QUESTION_TAIL_REGEX = /[?？]\s*$/;

const DEFER_PHRASES = [
  '待ってください',
  'お待ちください',
  'お待ちを',
  '少々お待ち',
  '少しお待ち',
  '少し時間',
  '少々時間',
  'しばらくお待ち',
  '後ほど',
];

const ACTION_VERBS = ['レビュー', '確認', '調査', '読み', '見直し', '検討', '精査', 'チェック'];

/**
 * 末尾段落（最後の連続した非空行ブロック）を抽出する。
 * 自動回答ループは「最終結論部分」だけを判定対象にしたいため。
 */
export function extractLastParagraph(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1].trim();
}

/**
 * Bot 応答に「ユーザーへの確認質問」または「保留宣言（後でやる宣言）」が
 * 含まれているかを判定する。auto-answer ループの起動条件。
 */
export function detectQuestionOrDefer(text: string): boolean {
  const last = extractLastParagraph(text);
  if (!last) return false;

  if (QUESTION_TAIL_REGEX.test(last)) return true;

  for (const phrase of DEFER_PHRASES) {
    if (last.includes(phrase)) return true;
  }

  // 「〜します。」末尾 + 直前に作業動詞（例: "レビューして結果を見せます。"）
  if (/[しま]す[。.\s]*$/.test(last)) {
    for (const verb of ACTION_VERBS) {
      if (last.includes(verb)) return true;
    }
  }

  return false;
}

export function buildAutoAnswerPrompt(prevResult: string): string {
  return [
    '[xangi auto-answer] あなたの直前の応答にユーザーへの質問または保留宣言が含まれていますが、ユーザーには届いていません。',
    '質問・保留・「後ほど」「あとで」は禁止です。今すぐ作業を完了し、最終結果のみを返してください。',
    '判断材料が不足しているなら一般的に妥当な仮定を置いて進めてください。',
    '',
    '直前の応答:',
    prevResult,
  ].join('\n');
}

/**
 * Bot 応答に質問/保留が含まれていたら、同セッションで自動回答を促し、
 * 質問が消えるか max ターンに達するまで繰り返す。
 *
 * 戻り値の result はユーザーに表示するべき最終応答。sessionId は
 * 最後の run で得たもの（呼び出し側で setSession する）。
 */
export async function runAutoAnswerLoop(
  runner: AgentRunner,
  initial: RunResult,
  options: RunOptions,
  config: AutoAnswerConfig
): Promise<RunResult & { turns: number }> {
  if (!config.enabled || config.maxTurns <= 0) {
    return { ...initial, turns: 0 };
  }

  let current = initial;
  let turns = 0;

  while (turns < config.maxTurns && detectQuestionOrDefer(current.result)) {
    turns++;
    const prompt = buildAutoAnswerPrompt(current.result);
    console.log(
      `[auto-answer] Turn ${turns}/${config.maxTurns}: detected question/defer, re-asking model`
    );
    const next = await runner.run(prompt, {
      ...options,
      sessionId: current.sessionId,
    });
    current = next;
  }

  if (turns > 0) {
    console.log(
      `[auto-answer] Loop finished after ${turns} turn(s), final length=${current.result.length}`
    );
  }

  return { ...current, turns };
}
