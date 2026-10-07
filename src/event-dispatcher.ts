/**
 * イベントの受け口: イベント源をポーリングし、負荷を見て Claude Code を起動する
 *
 * 流れ:
 * 1. 各イベント源を poll し、未記録のイベントをキューに積む
 * 2. 負荷がしきい値以下で、同時起動数に空きがあれば、古い順に起動する
 * 3. 起動・完了・失敗を通知する
 *
 * Why: すぐ起動するか後に回すかは、負荷の数値で決まるのでコードのルールで判断する。
 * 対応不要かどうかは issue を読まないと決められないので、起動した Claude Code に任せる。
 */
import { cpus, loadavg } from 'os';
import type { EventSource } from './event-source-github.js';
import type { AgentEvent, EventRecord, EventStore } from './event-store.js';

export interface EventConfig {
  enabled: boolean;
  githubRepos: string[];
  githubLabel: string;
  pollIntervalMs: number;
  /** 1 分間の load average を CPU コア数で割った値の上限 */
  maxLoadPerCpu: number;
  maxConcurrent: number;
  notifyChannelId?: string;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadEventConfig(env: NodeJS.ProcessEnv = process.env): EventConfig {
  const githubRepos = (env.EVENT_GITHUB_REPOS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  let enabled = env.EVENTS_ENABLED === 'true';
  if (enabled && githubRepos.length === 0) {
    console.warn(
      '[event-dispatcher] EVENTS_ENABLED=true but EVENT_GITHUB_REPOS is empty. Disabled.'
    );
    enabled = false;
  }
  return {
    enabled,
    githubRepos,
    githubLabel: env.EVENT_GITHUB_LABEL?.trim() || 'agent',
    pollIntervalMs: parsePositiveNumber(env.EVENT_POLL_INTERVAL_SEC, 300) * 1000,
    maxLoadPerCpu: parsePositiveNumber(env.EVENT_MAX_LOAD, 0.8),
    maxConcurrent: Math.floor(parsePositiveNumber(env.EVENT_MAX_CONCURRENT, 1)),
    notifyChannelId: env.EVENT_NOTIFY_CHANNEL_ID?.trim() || undefined,
  };
}

/** 1 分間の load average ÷ CPU コア数 が上限以下か */
export function isLoadAcceptable(
  maxLoadPerCpu: number,
  getLoad: () => number = () => loadavg()[0],
  cpuCount: number = cpus().length
): boolean {
  return getLoad() / Math.max(cpuCount, 1) <= maxLoadPerCpu;
}

/** プロンプトに入れる issue 本文の上限（長い本文は Claude Code が gh で読む） */
const PROMPT_BODY_LIMIT = 4000;
/** 通知に入れる結果の上限（Discord の 2000 文字制限に収める） */
const NOTIFY_RESULT_LIMIT = 1500;

export function buildEventPrompt(event: AgentEvent): string {
  const body =
    event.body.length > PROMPT_BODY_LIMIT
      ? `${event.body.slice(0, PROMPT_BODY_LIMIT)}\n…（以下省略。全文は URL から読むこと）`
      : event.body;
  return [
    `GitHub の issue に対応を依頼されました（イベント源: ${event.source}）。`,
    '',
    `- issue: ${event.id} ${event.title}`,
    `- URL: ${event.url}`,
    `- ラベル: ${event.labels.join(', ')}`,
    '',
    '## 本文',
    '',
    body,
    '',
    '## 進め方',
    '',
    '- issue を読み、対応が必要かを判断してください',
    '- 対応不要と判断したら、理由を issue にコメントして終了してください',
    '- 対応する場合は、結果を gh で issue にコメントするか PR を作ってください',
    '- 最後に、何をしたかを 3 行以内でまとめて返してください',
  ].join('\n');
}

export interface EventDispatcherOptions {
  sources: EventSource[];
  store: EventStore;
  /** イベントに対応する Claude Code を起動し、最終応答を返す */
  run: (prompt: string, event: AgentEvent) => Promise<string>;
  /** 通知を送る。失敗しても処理は続ける */
  notify: (message: string) => Promise<void>;
  maxConcurrent: number;
  isLoadAcceptable: () => boolean;
}

function logError(what: string, err: unknown): void {
  console.error(
    `[event-dispatcher] Failed to ${what}: ${err instanceof Error ? err.message : String(err)}`
  );
}

export class EventDispatcher {
  private running = 0;
  private polling = false;
  private timer?: ReturnType<typeof setInterval>;
  /** 負荷が高くて待たせていることを通知済みか（負荷が下がったら戻す） */
  private deferNotified = false;

  constructor(private options: EventDispatcherOptions) {}

  /** 起動中のまま残っていたイベントを通知し、ポーリングを始める */
  async start(intervalMs: number): Promise<void> {
    for (const event of this.options.store.markInterrupted()) {
      await this.safeNotify(
        `⚠️ 前回の起動中に xangi が止まったため、再実行しません: ${event.id} ${event.title}\n${event.url}`
      );
    }
    // 初回のポーリングが失敗しても、次の回からは動くよう先にタイマーを仕掛ける
    this.timer = setInterval(() => {
      this.poll().catch((err) => logError('poll', err));
    }, intervalMs);
    await this.poll().catch((err) => logError('poll', err));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 1 回分のポーリング。前回のポーリングが終わっていなければ何もしない */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const source of this.options.sources) {
        let events: AgentEvent[];
        try {
          events = await source.poll();
        } catch (err) {
          console.error(
            `[event-dispatcher] ${source.name} poll failed: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        for (const event of events) {
          if (this.options.store.enqueue(event)) {
            console.log(`[event-dispatcher] Queued ${event.source}:${event.id}`);
          }
        }
      }
      await this.drain();
    } finally {
      this.polling = false;
    }
  }

  /** 空きと負荷が許す限り、キューの古い順に起動する */
  private async drain(): Promise<void> {
    while (this.running < this.options.maxConcurrent) {
      const next = this.options.store.nextQueued();
      if (!next) return;
      if (!this.options.isLoadAcceptable()) {
        if (!this.deferNotified) {
          this.deferNotified = true;
          const count = this.options.store.countByStatus('queued');
          console.log(`[event-dispatcher] Load is high. ${count} event(s) waiting.`);
          await this.safeNotify(`⏳ PC の負荷が高いため、${count} 件のイベントを後で起動します`);
        }
        return;
      }
      this.deferNotified = false;
      await this.launch(next);
    }
  }

  private async launch(record: EventRecord): Promise<void> {
    const { event } = record;
    this.options.store.setStatus(event, 'running');
    this.running++;
    console.log(`[event-dispatcher] Launching ${event.source}:${event.id}`);
    await this.safeNotify(`🚀 起動します: ${event.id} ${event.title}\n${event.url}`);

    // 成功側の後処理で失敗しても failed に書き換えないよう、then の第 2 引数で失敗を受ける
    void this.options
      .run(buildEventPrompt(event), event)
      .then(
        async (result) => {
          this.options.store.setStatus(event, 'done');
          const text = String(result ?? '');
          const summary =
            text.length > NOTIFY_RESULT_LIMIT ? `${text.slice(0, NOTIFY_RESULT_LIMIT)}…` : text;
          await this.safeNotify(`✅ 完了: ${event.id} ${event.title}\n${event.url}\n\n${summary}`);
        },
        async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.options.store.setStatus(event, 'failed', message);
          await this.safeNotify(
            `❌ 失敗: ${event.id} ${event.title}\n${event.url}\n${message.slice(0, 200)}`
          );
        }
      )
      .catch((err) => logError(`record result of ${event.id}`, err))
      .finally(() => {
        this.running--;
        this.drain().catch((err) => logError('drain', err));
      });
  }

  private async safeNotify(message: string): Promise<void> {
    try {
      await this.options.notify(message);
    } catch (err) {
      console.error(
        `[event-dispatcher] Notify failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
