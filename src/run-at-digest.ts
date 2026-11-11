/**
 * 起動日（`xangi-run-at:`）を待っている issue の一覧を、週に 1 回 Slack に送る
 *
 * Why: 起動を待っている issue は、リポジトリを 1 つずつ開かないと分からない。
 * 日付を読めない issue はログに 1 回警告が出るだけで、ずっと起動しないので、書き間違いに気づけない。
 * 一覧はポーリングの結果とは別に、送るときに issue を取り直して作る（積み済みかどうかに左右されない）。
 */
import cron from 'node-cron';
import type { AgentEvent } from './event-store.js';
import { JST_OFFSET_MS, parseRunAt } from './run-at.js';

/** 毎週月曜の 09:00（JST） */
export const RUN_AT_DIGEST_CRON = '0 9 * * 1';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** `2026-11-20（金）09:00` の形にする（JST） */
export function formatJst(date: Date): string {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const iso = jst.toISOString();
  return `${iso.slice(0, 10)}（${WEEKDAYS[jst.getUTCDay()]}）${iso.slice(11, 16)}`;
}

/** Slack の mrkdwn で特別な意味を持つ文字を逃がす */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** タイトルをリンクにし、後ろにリポジトリ名と番号を添える（`owner/` は省く） */
function issueLine(event: AgentEvent): string {
  return `<${event.url}|${escapeSlack(event.title)}> ${escapeSlack(event.id.replace(/^[^/]*\//, ''))}`;
}

/**
 * 起動待ちと、日付を読めない issue の一覧を作る。どれもなければ undefined（投稿しない）
 * 起動日時を過ぎた issue は、ポーリングで積まれるので載せない
 * @param failedRepos issue を取れなかったリポジトリ。取れなかったことを 0 件と見分けられるよう載せる
 */
export function buildRunAtDigest(
  events: AgentEvent[],
  now: Date,
  failedRepos: string[] = []
): string | undefined {
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
  if (waiting.length === 0 && invalid.length === 0 && failedRepos.length === 0) return undefined;

  const lines: string[] = [];
  if (waiting.length > 0) {
    waiting.sort((a, b) => a.at.getTime() - b.at.getTime());
    lines.push(`*起動日を待っている issue（${waiting.length} 件）*`);
    // 同じ日時の issue は、1 つの日時の下にまとめる
    let current: string | undefined;
    for (const { event, at } of waiting) {
      const when = formatJst(at);
      if (when !== current) {
        lines.push(`• ${when}`);
        current = when;
      }
      lines.push(`    ◦ ${issueLine(event)}`);
    }
  }
  if (invalid.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `*起動日を読めず、起動しない issue（${invalid.length} 件）*`,
      '`xangi-run-at: YYYY-MM-DD` か `YYYY-MM-DDTHH:MM` に直すと起動します'
    );
    for (const { event, value } of invalid) {
      // 値にバッククォートがあるとコードの表示が切れるので外す。空なら空と書く
      const shown = value.replace(/`/g, '');
      lines.push(`• ${issueLine(event)}（${shown ? `\`${escapeSlack(shown)}\`` : '値が空'}）`);
    }
  }
  if (failedRepos.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`*issue を取れなかったリポジトリ（${failedRepos.length} 件）*`);
    for (const repo of failedRepos) lines.push(`• ${escapeSlack(repo)}`);
  }
  return lines.join('\n');
}

export interface RunAtDigestOptions {
  /** 対象の issue と、取れなかったリポジトリを返す。対象の一覧を取れなければ投げる */
  fetch: () => Promise<{ events: AgentEvent[]; failedRepos: string[] }>;
  /** 一覧を送る。送れなければ投げる */
  send: (message: string) => Promise<void>;
  /** テストで差し替える */
  now?: () => Date;
}

/**
 * issue を取り直して一覧を送る。送るものがなければ送らない
 * 対象の一覧を取れないときは、取れなかったことを送る（黙ると 0 件と区別できない）
 * @returns 送ったら true
 */
export async function sendRunAtDigest(options: RunAtDigestOptions): Promise<boolean> {
  let fetched: { events: AgentEvent[]; failedRepos: string[] };
  try {
    fetched = await options.fetch();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[run-at-digest] Failed to list targets: ${reason}`);
    await options.send(
      `*起動日を待っている issue の一覧を作れませんでした*\n${escapeSlack(reason)}`
    );
    return true;
  }
  const message = buildRunAtDigest(
    fetched.events,
    options.now?.() ?? new Date(),
    fetched.failedRepos
  );
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
