/**
 * イベント源: GitHub issue のポーリング
 *
 * 対象のリポジトリごとに、そのラベルが付いた open な issue を `gh issue list` で取る。
 * 対象の一覧はポーリングのたびに取り直す（ウォッチリストの変更を再起動なしで反映するため）。
 *
 * Why: Webhook を受けるには Mac mini を外部に公開する必要がある。
 * ポーリングなら外向きの通信だけで済み、手元の gh の認証をそのまま使える。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentEvent } from './event-store.js';

export interface EventSource {
  name: string;
  poll(): Promise<AgentEvent[]>;
}

/** gh を実行して標準出力を返す（テストで差し替える） */
export type GhExec = (args: string[]) => Promise<string>;

/** ポーリングの対象（リポジトリごとの設定） */
export interface RepoTarget {
  /** owner/repo */
  repo: string;
  label: string;
  /** Claude Code の作業ディレクトリ。未指定なら xangi のワークスペース */
  workdir?: string;
  /** 通知先の Discord チャンネル。未指定なら EVENT_NOTIFY_CHANNEL_ID */
  notifyChannelId?: string;
}

/** 対象の一覧を返す。投げたらそのポーリングを飛ばす */
export type RepoTargetProvider = () => Promise<RepoTarget[]>;

const execFileAsync = promisify(execFile);

const defaultGhExec: GhExec = async (args) => {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
}

export const GITHUB_ISSUE_SOURCE = 'github-issue';

/** 1 回のポーリングで取る issue の上限（リポジトリごと） */
const ISSUE_LIMIT = 50;

export class GitHubIssueSource implements EventSource {
  readonly name = GITHUB_ISSUE_SOURCE;

  constructor(
    private targets: RepoTargetProvider,
    private gh: GhExec = defaultGhExec
  ) {}

  /**
   * 全リポジトリの issue を取る。
   * 1 つのリポジトリで失敗しても、ほかのリポジトリの結果は返す。
   * @throws 対象の一覧を取れないとき
   */
  async poll(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const target of await this.targets()) {
      try {
        events.push(...(await this.pollRepo(target)));
      } catch (err) {
        console.error(
          `[event-source-github] Failed to list issues of ${target.repo}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return events;
  }

  private async pollRepo(target: RepoTarget): Promise<AgentEvent[]> {
    const { repo, label } = target;
    const stdout = await this.gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      String(ISSUE_LIMIT),
      '--json',
      'number,title,body,url,labels',
    ]);
    const issues = JSON.parse(stdout) as GhIssue[];
    // gh は新しい順に返す。キューは受け付け順に処理するので、古い issue から積む
    issues.sort((a, b) => a.number - b.number);
    return issues.map((issue) => ({
      source: GITHUB_ISSUE_SOURCE,
      id: `${repo}#${issue.number}`,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.url,
      labels: issue.labels.map((l) => l.name),
      ...(target.workdir ? { workdir: target.workdir } : {}),
      ...(target.notifyChannelId ? { notifyChannelId: target.notifyChannelId } : {}),
    }));
  }
}
