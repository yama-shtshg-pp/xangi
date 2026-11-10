/**
 * 起動日（`xangi-run-at:`）を待っている issue の一覧を、週に 1 回 Slack に送る
 *
 * Why: 起動を待っている issue は、リポジトリを 1 つずつ開かないと分からない。
 * 日付を読めない issue はログに 1 回警告が出るだけで、ずっと起動しないので、書き間違いに気づけない。
 * 一覧はポーリングの結果とは別に、送るときに issue を取り直して作る（積み済みかどうかに左右されない）。
 */
import cron from 'node-cron';
import type { EventSource } from './event-source-github.js';
import type { AgentEvent } from './event-store.js';
import { parseRunAt } from './run-at.js';

/** 毎週月曜の 09:00（JST） */
export const RUN_AT_DIGEST_CRON = '0 9 * * 1';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `2026-11-20 09:00` の形にする（JST） */
export function formatJst(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Slack の mrkdwn で特別な意味を持つ文字を逃がす */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(event: AgentEvent): string {
  return `<${event.url}|${escapeSlack(event.id)}>`;
}

/**
 * 起動待ちと、日付を読めない issue の一覧を作る。両方なければ undefined（投稿しない）
 * 起動日時を過ぎた issue は、ポーリングで積まれるので載せない
 */
export function buildRunAtDigest(events: AgentEvent[], now: Date): string | undefined {
  const waiting: { event: AgentEvent; at: Date }[] = [];
  const invalid: { event: AgentEvent; value: string }[] = [];
  for (const event of events) {
    const runAt = parseRunAt(event.body);
    if (runAt.kind === 'valid' && runAt.at.getTime() > now.getTime()) {
      waiting.push({ event, at: runAt.at });
    } else if (runAt.kind === 'invalid') {
      invalid.push({ event, value: runAt.value });
    }
  }
  if (waiting.length === 0 && invalid.length === 0) return undefined;

  const lines: string[] = [];
  if (waiting.length > 0) {
    waiting.sort((a, b) => a.at.getTime() - b.at.getTime());
    lines.push(`*起動日を待っている issue（${waiting.length} 件）*`);
    for (const { event, at } of waiting) {
      lines.push(`• ${formatJst(at)} ${link(event)} ${escapeSlack(event.title)}`);
    }
  }
  if (invalid.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `*起動日を読めず、起動しない issue（${invalid.length} 件）*`,
      '`xangi-run-at: YYYY-MM-DD` か `YYYY-MM-DDTHH:MM` に直すと起動します'
    );
    for (const { event, value } of invalid) {
      // 値にバッククォートがあるとコードの表示が切れるので外す
      lines.push(
        `• ${link(event)} ${escapeSlack(event.title)}（\`${escapeSlack(value.replace(/`/g, ''))}\`）`
      );
    }
  }
  return lines.join('\n');
}

export interface RunAtDigestOptions {
  sources: EventSource[];
  /** 一覧を送る。送れなければ投げる */
  send: (message: string) => Promise<void>;
  /** テストで差し替える */
  now?: () => Date;
}

/**
 * issue を取り直して一覧を送る。送るものがなければ送らない
 * イベント源の 1 つが失敗しても、ほかの源の一覧は送る
 * @returns 送ったら true
 */
export async function sendRunAtDigest(options: RunAtDigestOptions): Promise<boolean> {
  const events: AgentEvent[] = [];
  for (const source of options.sources) {
    try {
      events.push(...(await source.poll()));
    } catch (err) {
      console.error(
        `[run-at-digest] ${source.name} poll failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const message = buildRunAtDigest(events, options.now?.() ?? new Date());
  if (!message) {
    console.log('[run-at-digest] No issues waiting for xangi-run-at');
    return false;
  }
  await options.send(message);
  console.log('[run-at-digest] Sent');
  return true;
}

/** 毎週月曜の 09:00（JST）に一覧を送る。止めるときは戻り値の stop を呼ぶ */
export function startRunAtDigest(options: RunAtDigestOptions): { stop: () => void } {
  const task = cron.schedule(
    RUN_AT_DIGEST_CRON,
    () => {
      sendRunAtDigest(options).catch((err) => {
        console.error(
          `[run-at-digest] Failed to send: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    },
    { timezone: 'Asia/Tokyo' }
  );
  return { stop: () => task.stop() };
}
