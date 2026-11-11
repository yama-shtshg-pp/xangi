/**
 * issue から起動した Claude Code が返答を終えるたびに、作業の状態を Jev で判定する
 *
 * Stop のフック（http）で受けた直近の返答と issue のタイトルから、
 * 「完了」「継続」「同じ所で詰まっている」「人間に聞くべき」の 4 つから選ばせる。
 * on のときは、人間に聞くべき・続けて詰まっていると判定したら通知先に知らせる。
 *
 * Why: issue から起動した Claude Code は、返答を終えると入力待ちになる。
 * 詰まったまま入力待ちになっていても、今は誰にも知らされない。
 * Jev の判定は通知を増やす方向にだけ使い、セッションの動きは変えない。
 * Jev は呼び出し間の記憶を持たないので、何回目の返答かと前回の判定は xangi がセッションごとに覚えて渡す。
 */
import { appendJevLog, callJev, type JevQuestion } from './jev-client.js';

export type JevLoopWatchMode = 'off' | 'shadow' | 'on';

/** JEV_LOOP_WATCH を読む。未設定・不明な値は 'off' */
export function getJevLoopWatchMode(env: NodeJS.ProcessEnv = process.env): JevLoopWatchMode {
  const value = env.JEV_LOOP_WATCH?.trim().toLowerCase();
  if (value === 'shadow' || value === 'on') return value;
  if (value && value !== 'off') {
    console.warn(`[loop-watch] Unknown JEV_LOOP_WATCH "${value}". Loop watch is off.`);
  }
  return 'off';
}

export const LOOP_STATES = ['done', 'continue', 'stuck', 'ask_human'] as const;
export type LoopState = (typeof LOOP_STATES)[number];

/** Jev の呼び出しのタイムアウト。フックには判定を待たずに応答するので、作業は遅れない */
export const DEFAULT_LOOP_WATCH_TIMEOUT_MS = 1500;
/** state に入れる直近の返答の末尾 */
const STATE_MESSAGE_LIMIT = 2000;
/** ログに残す返答の先頭と末尾（秘密が含まれることがあるので全文は残さない） */
const LOG_MESSAGE_LIMIT = 100;
/** 通知に添える返答の末尾 */
const NOTIFY_MESSAGE_LIMIT = 300;
/** stuck が続けて何回出たら知らせるか */
export const STUCK_STREAK_TO_NOTIFY = 2;

export const LOOP_STATE_QUESTION: JevQuestion = {
  type: 'choice',
  instructions:
    '`last_message` は、GitHub の issue（タイトルは `issue`）に取り組んでいる AI コーディングエージェントが、返答を終えたときの最後のメッセージです。`turn` はこのセッションで何回目の返答か、`previous_state` は前回の返答のときの判定です（初回は none）。エージェントの作業は、いまどの状態ですか。',
  criteria: {
    done: 'issue の作業を終えたと報告している（PR を作った、issue にコメントした・閉じたなど）',
    continue: '作業の途中で、進み具合や次にやることを報告している。人の判断がなくても先に進める',
    stuck: '同じエラーや失敗を繰り返している、または手詰まりで先に進めていない',
    ask_human: '人に質問している、または判断・承認・情報の提供を人に求めている',
  },
};

function tail(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

/**
 * 通知に引用する返答を整える
 * エージェントの出力に @everyone やメンションがあっても、通知先で人を呼ばないようにする。
 * コードブロックの区切りで引用が崩れないよう、``` も崩す
 */
export function quoteAgentMessage(text: string): string {
  return text
    .replace(/@/g, '@\u200b')
    .replace(/<(@|#)/g, '<\u200b$1')
    .replace(/```/g, "'''")
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface LoopStateInput {
  issueTitle: string;
  lastMessage: string;
  /** そのセッションで何回目の返答か（1 始まり） */
  turn: number;
  /** 前回の判定。初回や前回が失敗なら undefined */
  previous?: LoopState;
}

export interface LoopStateJudgement {
  ok: boolean;
  state?: LoopState;
  probabilities?: Record<string, number>;
  jevModel?: string;
  latencyMs: number;
  error?: string;
}

/** 作業の状態を Jev に聞く。失敗しても例外は投げない */
export async function judgeLoopState(
  input: LoopStateInput,
  timeoutMs: number = DEFAULT_LOOP_WATCH_TIMEOUT_MS
): Promise<LoopStateJudgement> {
  const res = await callJev({
    state: {
      issue: input.issueTitle,
      last_message: tail(input.lastMessage, STATE_MESSAGE_LIMIT),
      turn: input.turn,
      previous_state: input.previous ?? 'none',
    },
    questions: { state: LOOP_STATE_QUESTION },
    timeoutMs,
  });
  if (!res.ok) return { ok: false, latencyMs: res.latencyMs, error: res.error };
  const answer = res.answers.state;
  const choice = answer?.choice;
  if (!choice || !(LOOP_STATES as readonly string[]).includes(choice)) {
    return {
      ok: false,
      latencyMs: res.latencyMs,
      jevModel: res.model,
      error: `unexpected answer: choice=${String(choice)}`,
    };
  }
  return {
    ok: true,
    state: choice as LoopState,
    probabilities: answer.probabilities,
    jevModel: res.model,
    latencyMs: res.latencyMs,
  };
}

export interface LoopStopInput {
  /** tmux のセッション名 */
  session: string;
  /** issue の ID（owner/repo#12）とタイトル。分からなければ undefined */
  issueId?: string;
  issueTitle?: string;
  /** Stop のフックの入力の last_assistant_message。なければ undefined */
  lastMessage?: string;
}

/** 通知先に知らせる内容 */
export interface LoopWatchAlert {
  session: string;
  issueId?: string;
  issueTitle?: string;
  state: 'stuck' | 'ask_human';
  /** 直近の返答の末尾 */
  messageTail: string;
}

export type JudgeLoopState = (input: LoopStateInput) => Promise<LoopStateJudgement>;

export interface LoopWatcherOptions {
  mode: JevLoopWatchMode;
  /** 判定のログ（JSONL）の書き出し先 */
  logPath: string;
  judge?: JudgeLoopState;
  /** on のときに呼ぶ。失敗しても例外は外に出さない */
  notify?: (alert: LoopWatchAlert) => Promise<void>;
}

/** セッションごとに覚えておくこと */
interface SessionMemory {
  turn: number;
  previous?: LoopState;
  stuckStreak: number;
  /** 最後に知らせた状態。状態が変わるまで同じ通知を繰り返さない */
  notified?: LoopWatchAlert['state'];
}

export class LoopWatcher {
  private judge: JudgeLoopState;
  private sessions = new Map<string, SessionMemory>();
  /** 同じセッションの判定を順に処理する（前回の判定を正しく渡すため） */
  private queues = new Map<string, Promise<void>>();

  constructor(private options: LoopWatcherOptions) {
    this.judge = options.judge ?? ((input) => judgeLoopState(input));
  }

  get mode(): JevLoopWatchMode {
    return this.options.mode;
  }

  /** セッションの回数と判定を忘れる。同じ名前で起動し直すときに呼ぶ */
  forget(session: string): void {
    this.sessions.delete(session);
  }

  /**
   * 返答を終えたときに呼ぶ。例外は投げない
   * - off: 何もしない（フックも付けない前提）
   * - shadow: 判定をログに残すだけ
   * - on: 判定をログに残し、必要なら知らせる
   */
  handleStop(input: LoopStopInput): Promise<void> {
    if (this.options.mode === 'off') return Promise.resolve();
    const previous = this.queues.get(input.session) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(input))
      .catch((err) => {
        console.error(
          `[loop-watch] ${err instanceof Error ? err.message : String(err)} (session: ${input.session})`
        );
      });
    this.queues.set(input.session, next);
    void next.finally(() => {
      if (this.queues.get(input.session) === next) this.queues.delete(input.session);
    });
    return next;
  }

  private async run(input: LoopStopInput): Promise<void> {
    const memory = this.sessions.get(input.session) ?? { turn: 0, stuckStreak: 0 };
    this.sessions.set(input.session, memory);
    memory.turn += 1;
    const message = input.lastMessage ?? '';

    let judgement: LoopStateJudgement;
    if (!input.lastMessage) {
      judgement = { ok: false, latencyMs: 0, error: 'no last_assistant_message' };
    } else {
      try {
        judgement = await this.judge({
          issueTitle: input.issueTitle ?? '',
          lastMessage: message,
          turn: memory.turn,
          previous: memory.previous,
        });
      } catch (err) {
        judgement = {
          ok: false,
          latencyMs: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const previous = memory.previous;
    let alert: LoopWatchAlert['state'] | undefined;
    // 失敗したときは何もしない（前回の判定と stuck の回数も変えない）
    if (judgement.ok && judgement.state) {
      const state = judgement.state;
      memory.previous = state;
      memory.stuckStreak = state === 'stuck' ? memory.stuckStreak + 1 : 0;
      if (state === 'ask_human') alert = 'ask_human';
      else if (state === 'stuck' && memory.stuckStreak >= STUCK_STREAK_TO_NOTIFY) alert = 'stuck';
      if (alert && memory.notified === alert) alert = undefined;
      else if (!alert) memory.notified = undefined;
      // shadow でも on と同じように覚え、ログの alert で「on なら知らせたか」を確かめられるようにする
      if (alert) memory.notified = alert;
    }
    const notify = this.options.mode === 'on' && alert !== undefined;

    await appendJevLog(this.options.logPath, {
      timestamp: new Date().toISOString(),
      mode: this.options.mode,
      session: input.session,
      issue: input.issueId ?? null,
      turn: memory.turn,
      state: judgement.state ?? null,
      probabilities: judgement.probabilities ?? null,
      previous: previous ?? null,
      message_head: message.slice(0, LOG_MESSAGE_LIMIT),
      message_tail: message.slice(-LOG_MESSAGE_LIMIT),
      message_length: message.length,
      // on なら知らせた状態（shadow では知らせない）
      alert: alert ?? null,
      latency_ms: judgement.latencyMs,
      error: judgement.error ?? null,
      jev_model: judgement.jevModel ?? null,
    });

    if (notify && alert && this.options.notify) {
      try {
        await this.options.notify({
          session: input.session,
          issueId: input.issueId,
          issueTitle: input.issueTitle,
          state: alert,
          messageTail: tail(message, NOTIFY_MESSAGE_LIMIT),
        });
      } catch (err) {
        console.error(
          `[loop-watch] Failed to notify: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
