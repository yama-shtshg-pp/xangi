/**
 * イベント源: GitHub issue のポーリング
 *
 * 指定したリポジトリの、指定ラベルが付いた open な issue を `gh issue list` で取る。
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
    private repos: string[],
    private label: string,
    private gh: GhExec = defaultGhExec
  ) {}

  /**
   * 全リポジトリの issue を取る。
   * 1 つのリポジトリで失敗しても、ほかのリポジトリの結果は返す。
   */
  async poll(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const repo of this.repos) {
      try {
        events.push(...(await this.pollRepo(repo)));
      } catch (err) {
        console.error(
          `[event-source-github] Failed to list issues of ${repo}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return events;
  }

  private async pollRepo(repo: string): Promise<AgentEvent[]> {
    const stdout = await this.gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      this.label,
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
    }));
  }
}
