/**
 * イベントの受け付け記録（キューと処理済みの記録）
 *
 * `DATA_DIR/events.json` に保存する。
 * 一度記録したイベントは、状態にかかわらず二度と受け付けない（同じ issue で 2 回起動しない）。
 *
 * Why: xangi の再起動をまたいでも二重起動しないよう、状態はファイルに残す。
 * 起動中（running）のイベントは tmux のセッション名を持ち、セッションがなくなったら終了とみなす。
 * xangi を再起動しても、セッションが残っていれば起動中のまま扱い、自動では再実行しない。
 * 同じ理由で、ファイルが読めないときは空から始めずに例外を投げる
 * （空から始めると、ラベルの付いた issue をすべて起動し直してしまう）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface AgentEvent {
  /** イベント源の名前（例: github-issue） */
  source: string;
  /** イベント源の中で一意な ID（例: owner/repo#12） */
  id: string;
  title: string;
  body: string;
  url: string;
  labels: string[];
  /** Claude Code の作業ディレクトリ（ウォッチリストの path）。未指定なら xangi のワークスペース */
  workdir?: string;
  /** 起動・終了・失敗の通知先。未指定なら EVENT_NOTIFY_CHANNEL_ID */
  notifyChannelId?: string;
}

export type EventStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';

export interface EventRecord {
  event: AgentEvent;
  status: EventStatus;
  /** 受け付けた時刻（ISO 8601）。キューはこの古い順に処理する */
  receivedAt: string;
  updatedAt: string;
  error?: string;
  /** 起動した tmux のセッション名（running のとき） */
  sessionName?: string;
}

export class EventStore {
  private records = new Map<string, EventRecord>();

  constructor(private filePath: string) {
    this.load();
  }

  private key(event: Pick<AgentEvent, 'source' | 'id'>): string {
    return `${event.source}:${event.id}`;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let raw: { records?: EventRecord[] };
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { records?: EventRecord[] };
    } catch (err) {
      throw new Error(
        `Failed to read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const record of raw.records ?? []) {
      this.records.set(this.key(record.event), record);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const data = { records: Array.from(this.records.values()) };
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  has(event: Pick<AgentEvent, 'source' | 'id'>): boolean {
    return this.records.has(this.key(event));
  }

  /** 新しいイベントをキューに積む。記録済みなら false */
  enqueue(event: AgentEvent): boolean {
    if (this.has(event)) return false;
    const now = new Date().toISOString();
    this.records.set(this.key(event), { event, status: 'queued', receivedAt: now, updatedAt: now });
    this.save();
    return true;
  }

  /** キューの先頭（受け付けが古い順） */
  nextQueued(): EventRecord | undefined {
    let oldest: EventRecord | undefined;
    for (const record of this.records.values()) {
      if (record.status !== 'queued') continue;
      if (!oldest || record.receivedAt < oldest.receivedAt) oldest = record;
    }
    return oldest;
  }

  countByStatus(status: EventStatus): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === status) count++;
    }
    return count;
  }

  setStatus(event: Pick<AgentEvent, 'source' | 'id'>, status: EventStatus, error?: string): void {
    const record = this.records.get(this.key(event));
    if (!record) return;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (error !== undefined) record.error = error;
    else delete record.error;
    this.save();
  }

  listByStatus(status: EventStatus): EventRecord[] {
    return Array.from(this.records.values()).filter((record) => record.status === status);
  }

  /** 起動中にし、tmux のセッション名を残す */
  setRunning(event: Pick<AgentEvent, 'source' | 'id'>, sessionName: string): void {
    const record = this.records.get(this.key(event));
    if (!record) return;
    record.sessionName = sessionName;
    this.setStatus(event, 'running');
  }
}
