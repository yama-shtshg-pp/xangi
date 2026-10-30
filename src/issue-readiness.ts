/**
 * issue の内容で作業を始められるかを Jev（TypeSafe System One）で判定する
 *
 * Slack のメンションから issue を立てる前と、agent ラベルの issue から Claude Code を起動する前に使う。
 *
 * Why: 本文が空・目的が分からない issue で Claude Code を起動すると、何をするかを人に聞くところから始まる。
 * 起動の前に足りないものを返せば、人が書き足してから起動できる。
 * Jev は判定だけを担当し、止めるかどうかはモード（JEV_READINESS）とコードのルールで決める。
 * 判定に失敗したときは、作業を始められるとみなして既存の挙動に戻す（fail-open）。
 */
import { appendJevLog, callJev, type JevQuestion } from './jev-client.js';

export type JevReadinessMode = 'off' | 'shadow' | 'on';

/** JEV_READINESS を読む。未設定・不明な値は 'off' */
export function getJevReadinessMode(env: NodeJS.ProcessEnv = process.env): JevReadinessMode {
  const value = env.JEV_READINESS?.trim().toLowerCase();
  if (value === 'shadow' || value === 'on') return value;
  if (value && value !== 'off') {
    console.warn(`[issue-readiness] Unknown JEV_READINESS "${value}". Readiness check is off.`);
  }
  return 'off';
}

export type MissingKind = 'purpose' | 'target' | 'done' | 'repro';

/** 足りないもの → 人に見せる言葉 */
export const MISSING_LABELS: Record<MissingKind, string> = {
  purpose: '目的（何のために何をするか）',
  target: '対象（どのリポジトリ・機能・ファイルか）',
  done: '完了の条件（何ができたら終わりか）',
  repro: '再現の手順（不具合ならどうすると起きるか）',
};

/** Noul がこれ未満なら、作業を始められないとみなす */
export const READY_THRESHOLD = 0.5;

/** state に入れる本文の上限（長文の貼り付けで入力トークンが膨らむのを防ぐ） */
const STATE_BODY_LIMIT = 4000;
/** ログに残す本文の先頭 */
const LOG_BODY_LIMIT = 200;

export const READY_QUESTION: JevQuestion = {
  type: 'noul',
  instructions:
    '`title` と `body` は、AI コーディングエージェントに作業を頼む GitHub issue です。エージェントは人に質問せずに作業を始めます。この内容だけで、何を作る・直す・調べるかが分かり、作業を始められますか。',
  criteria: {
    true: '目的と対象が読み取れ、エージェントが最初の作業に取りかかれる',
    false: '本文が空、または一言だけで、何をすればよいか人に聞かないと分からない',
  },
};

export const MISSING_QUESTION: JevQuestion = {
  type: 'choice',
  instructions:
    '`title` と `body` は、AI コーディングエージェントに作業を頼む GitHub issue です。作業を始めるために、いちばん足りていない情報を選んでください。',
  criteria: {
    purpose: '何のために何をしたいのか（目的）が分からない',
    target: 'どのリポジトリ・機能・ファイルが対象かが分からない',
    done: '何ができたら終わりなのか（完了の条件）が分からない',
    repro: '不具合の報告だが、どうすると起きるのか（再現の手順）が分からない',
  },
};

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export interface IssueReadiness {
  ok: boolean;
  /** 作業を始められる確率（失敗時は undefined） */
  ready?: number;
  /** いちばん足りていないもの */
  missing?: MissingKind;
  missingProbabilities?: Record<string, number>;
  jevModel?: string;
  latencyMs: number;
  error?: string;
}

/** 1 回の呼び出しで、始められるかと、足りないものを並列に聞く。失敗しても例外は投げない */
export async function judgeIssueReadiness(
  title: string,
  body: string,
  timeoutMs?: number
): Promise<IssueReadiness> {
  const res = await callJev({
    state: { title, body: truncate(body.trim(), STATE_BODY_LIMIT) || '（本文なし）' },
    questions: { ready: READY_QUESTION, missing: MISSING_QUESTION },
    timeoutMs,
  });
  if (!res.ok) return { ok: false, latencyMs: res.latencyMs, error: res.error };

  const ready = res.answers.ready?.noul;
  if (typeof ready !== 'number') {
    return {
      ok: false,
      latencyMs: res.latencyMs,
      jevModel: res.model,
      error: `unexpected ready answer: ${String(ready)}`,
    };
  }
  const choice = res.answers.missing?.choice;
  const missing =
    choice && Object.hasOwn(MISSING_LABELS, choice) ? (choice as MissingKind) : undefined;
  return {
    ok: true,
    ready,
    missing,
    missingProbabilities: res.answers.missing?.probabilities,
    jevModel: res.model,
    latencyMs: res.latencyMs,
  };
}

export interface ReadinessInput {
  /** 呼び出し元 */
  source: 'slack' | 'github';
  /** owner/repo */
  repo: string;
  /** github なら owner/repo#12。slack なら channel:ts */
  id: string;
  title: string;
  body: string;
}

/** 呼び出し元が従う結果。notReady が true のときだけ、止める・書き足すなどをする */
export interface ReadinessVerdict {
  notReady: boolean;
  /** 足りないもの（人に見せる言葉）。分からなければ undefined */
  missing?: string;
}

const READY: ReadinessVerdict = { notReady: false };

/** 判定の結果を受け取る関数（テストで差し替える） */
export type JudgeReadiness = (title: string, body: string) => Promise<IssueReadiness>;

export interface IssueReadinessCheckerOptions {
  mode: JevReadinessMode;
  /** 判定のログ（JSONL）の書き出し先 */
  logPath: string;
  judge?: JudgeReadiness;
}

export class IssueReadinessChecker {
  private judge: JudgeReadiness;

  constructor(private options: IssueReadinessCheckerOptions) {
    this.judge = options.judge ?? ((title, body) => judgeIssueReadiness(title, body));
  }

  get mode(): JevReadinessMode {
    return this.options.mode;
  }

  /**
   * 作業を始められるかを判定する。例外は投げない
   * - off: Jev を呼ばない
   * - shadow: 判定を待たずに返し、結果はログに残すだけ（応答時間を変えない）
   * - on: 判定を待ち、始められないときは notReady を返す
   */
  async check(input: ReadinessInput): Promise<ReadinessVerdict> {
    if (this.options.mode === 'off') return READY;
    const run = this.run(input);
    if (this.options.mode === 'shadow') {
      void run;
      return READY;
    }
    return run;
  }

  private async run(input: ReadinessInput): Promise<ReadinessVerdict> {
    let result: IssueReadiness;
    try {
      result = await this.judge(input.title, input.body);
    } catch (err) {
      result = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const notReady = result.ok && (result.ready ?? 1) < READY_THRESHOLD;
    await appendJevLog(this.options.logPath, {
      timestamp: new Date().toISOString(),
      mode: this.options.mode,
      source: input.source,
      repo: input.repo,
      id: input.id,
      title: input.title,
      body: input.body.slice(0, LOG_BODY_LIMIT),
      body_length: input.body.length,
      ready: result.ready ?? null,
      not_ready: notReady,
      missing: result.missing ?? null,
      missing_probabilities: result.missingProbabilities ?? null,
      latency_ms: result.latencyMs,
      error: result.error ?? null,
      jev_model: result.jevModel ?? null,
    });
    if (!notReady) return READY;
    return { notReady, missing: result.missing ? MISSING_LABELS[result.missing] : undefined };
  }
}
