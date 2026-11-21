/**
 * Slack で xangi の使い方を聞かれたときに返す早見表と、聞かれたかどうかの判定
 *
 * 決まった言葉（`使い方`、`help` など）は Jev を呼ばずに判定する。
 * 「起動日ってどう書くんだっけ」のような自然な文は、Jev（TypeSafe System One）で判定する。
 *
 * Why: 起動の指定の書き方は、人が覚えていられない。スマホの Slack からすぐ引けるようにする。
 * issue を立てる専用のインスタンスは Slack で会話しない（#50）ので、答えは Claude Code ではなく決まった文にする。
 * Jev は判定だけを担当し、返すかどうかはモード（JEV_HELP）としきい値で決める。
 * 判定に失敗したときは、早見表を返さず今までの挙動に戻す（fail-open）。
 */
import type { RepoTarget } from './event-source-github.js';
import { appendJevLog, callJev, type JevQuestion } from './jev-client.js';
import { normalizeKey } from './watch-repos.js';

export type JevHelpMode = 'off' | 'shadow' | 'on';

/** JEV_HELP を読む。未設定・不明な値は 'off' */
export function getJevHelpMode(env: NodeJS.ProcessEnv = process.env): JevHelpMode {
  const value = env.JEV_HELP?.trim().toLowerCase();
  if (value === 'shadow' || value === 'on') return value;
  if (value && value !== 'off') {
    console.warn(`[slack-help] Unknown JEV_HELP "${value}". Help detection is off.`);
  }
  return 'off';
}

/**
 * Noul がこれ以上なら、使い方を聞いていると判定する
 * Why: 誤って早見表を返すと、issue を立てたかった人が issue を立てられず、key 付きで打ち直すことになる。
 * 早見表を返しそびれても、人が `使い方` と打てば出るので、高めにする。
 */
export const HELP_THRESHOLD = 0.7;

/** Jev に渡す文の上限（長文の貼り付けで入力トークンが膨らむのを防ぐ） */
const TEXT_LIMIT = 2000;
/** ログに残す文の先頭 */
const LOG_TEXT_LIMIT = 200;

/** 決まった言葉（小文字にして比べる） */
const HELP_WORDS = ['使い方', 'ヘルプ', 'help', '?', '？'];

/** メンションを除いた文が、決まった言葉だけか。前後の空白、大文字・小文字、末尾の ? / ？ は区別しない */
export function isHelpWord(text: string): boolean {
  const word = text.trim().toLowerCase();
  return HELP_WORDS.includes(word) || HELP_WORDS.includes(word.replace(/[?？]+$/, '').trim());
}

const USAGE_URL = 'https://github.com/yama-shtshg-pp/xangi/blob/main/docs/usage.md';

function usageLink(anchor: string, label: string): string {
  return `<${USAGE_URL}#${encodeURIComponent(anchor)}|${label}>`;
}

/** 早見表。key の一覧（keyTable の出力）を末尾に付ける */
export function buildHelpText(keyTableText: string): string {
  return [
    '*xangi の使い方*',
    'issue に `agent` ラベルを付けると、Claude Code が起動します',
    '- 起動する日: 本文の行頭に `起動: 11/20 14時`（`xangi-run-at: 2026-11-20T14:00` も可）',
    '- 前の issue を待つ: 本文の行頭に `待つ: #12, repo#3, issue の URL`',
    '  - GitHub の「Blocked by」に指定した issue も待ちます',
    // Slack の mrkdwn では < > が制御記法なので、&lt; &gt; にエスケープする（コードスパンの中も同じ）
    '- Slack から issue を立てる: `@xangi &lt;key&gt; 内容`',
    '  - スレッドの中なら `@xangi &lt;key&gt;` だけで、スレッドのやり取りを issue にします',
    `詳しい説明: ${usageLink('起動する日を指定する', '起動する日')} / ${usageLink('先に終わらせる-issue-を指定する', '前の issue を待つ')} / ${usageLink('slack-のメンションから-issue-を立てる', 'Slack から立てる')}`,
    'key の一覧',
    keyTableText,
  ].join('\n');
}

/**
 * 決まった言葉と同じ名前の key を返す（normalizeKey で比べる）
 * Why: 決まった言葉は key を探すより前に判定するので、同じ名前の key には Slack から issue を立てられない
 */
export function findHelpWordKeys(targets: RepoTarget[]): string[] {
  const words = HELP_WORDS.map((w) => normalizeKey(w));
  return targets
    .map((t) => t.key)
    .filter((key): key is string => !!key && words.includes(normalizeKey(key)));
}

export const HELP_QUESTION: JevQuestion = {
  type: 'noul',
  instructions:
    '`text` は、Slack で xangi（GitHub の issue から Claude Code を起動する Bot）にメンションして送られた文です。この文は、xangi の使い方・書き方（起動する日の書き方、前の issue を待つ書き方、Slack から issue を立てる書き方など）を聞いていますか。',
  criteria: {
    true: 'xangi の使い方や書き方を、人が知りたがっている質問である',
    false: '不具合の報告や作業の依頼など、issue にしたい内容である。使い方を聞いていない',
  },
};

export interface HelpJudgement {
  ok: boolean;
  /** 使い方を聞いている確率（失敗時は undefined） */
  help?: number;
  jevModel?: string;
  latencyMs: number;
  error?: string;
}

/** 判定の結果を受け取る関数（テストで差し替える） */
export type JudgeHelp = (text: string) => Promise<HelpJudgement>;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 使い方を聞いているかを Jev に聞く。失敗しても例外は投げない */
export async function judgeHelpRequest(text: string, timeoutMs?: number): Promise<HelpJudgement> {
  const res = await callJev({
    state: { text: truncate(text.trim(), TEXT_LIMIT) },
    questions: { help: HELP_QUESTION },
    timeoutMs,
  });
  if (!res.ok) return { ok: false, latencyMs: res.latencyMs, error: res.error };

  const help = res.answers.help?.noul;
  if (typeof help !== 'number') {
    return {
      ok: false,
      latencyMs: res.latencyMs,
      jevModel: res.model,
      error: `unexpected help answer: ${String(help)}`,
    };
  }
  return { ok: true, help, jevModel: res.model, latencyMs: res.latencyMs };
}

export interface HelpCheckerOptions {
  mode: JevHelpMode;
  /** 判定のログ（JSONL）の書き出し先 */
  logPath: string;
  judge?: JudgeHelp;
}

export class HelpChecker {
  private judge: JudgeHelp;

  constructor(private options: HelpCheckerOptions) {
    this.judge = options.judge ?? ((text) => judgeHelpRequest(text));
  }

  get mode(): JevHelpMode {
    return this.options.mode;
  }

  /**
   * 使い方を聞いているかを判定する。例外は投げない
   * - off: Jev を呼ばず false
   * - shadow: 判定を待たずに false を返し、結果はログに残すだけ（応答時間を変えない）
   * - on: 判定を待ち、しきい値以上なら true
   */
  async check(input: { id: string; text: string }): Promise<boolean> {
    if (this.options.mode === 'off') return false;
    const run = this.run(input);
    if (this.options.mode === 'shadow') {
      void run;
      return false;
    }
    return run;
  }

  private async run(input: { id: string; text: string }): Promise<boolean> {
    let result: HelpJudgement;
    try {
      result = await this.judge(input.text);
    } catch (err) {
      result = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const isHelp = result.ok && (result.help ?? 0) >= HELP_THRESHOLD;
    await appendJevLog(this.options.logPath, {
      timestamp: new Date().toISOString(),
      mode: this.options.mode,
      id: input.id,
      text: input.text.slice(0, LOG_TEXT_LIMIT),
      text_length: input.text.length,
      help: result.help ?? null,
      is_help: isHelp,
      latency_ms: result.latencyMs,
      error: result.error ?? null,
      jev_model: result.jevModel ?? null,
    });
    return isHelp;
  }
}
