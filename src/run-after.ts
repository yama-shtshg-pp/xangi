/**
 * issue の本文に書いた、先に終わらせる issue（`xangi-run-after: #12, owner/repo#3`）を読む
 *
 * Why: 前の issue が終わってから始める issue は、前の issue が終わったときに `agent` ラベルを付けていた。
 * 付けるよう指示しないと、エージェントは後続の issue を探してラベルを付けない。
 * 本文の 1 行で待つ issue を書き、ラベルは最初から付けておけるようにする。
 */

/** 行頭の `xangi-run-after:` の値を取る。行が複数あれば、すべての行の issue を待つ */
const RUN_AFTER_LINE = /^xangi-run-after:[ \t]*(.*?)[ \t]*$/gm;
/** `#12` か `owner/repo#12` */
const ISSUE_REF = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

export interface IssueRef {
  /** owner/repo */
  repo: string;
  number: number;
}

export type RunAfter =
  | { kind: 'none' }
  | { kind: 'valid'; issues: IssueRef[] }
  | { kind: 'invalid'; value: string };

/**
 * 本文から待つ issue を読む。行がなければ none、1 つでも読めない値があれば invalid
 * @param repo `#12` のように書いたときのリポジトリ（本文を書いた issue のリポジトリ）
 */
export function parseRunAfter(body: string, repo: string): RunAfter {
  const issues: IssueRef[] = [];
  const seen = new Set<string>();
  let found = false;
  for (const line of body.matchAll(RUN_AFTER_LINE)) {
    found = true;
    const value = line[1];
    const refs = value.split(',').map((s) => s.trim());
    for (const ref of refs) {
      const m = ISSUE_REF.exec(ref);
      if (!m) return { kind: 'invalid', value };
      const issue = { repo: m[1] ?? repo, number: Number(m[2]) };
      // リポジトリ名は大文字・小文字を区別しない
      const key = issueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  return found ? { kind: 'valid', issues } : { kind: 'none' };
}

export function issueKey(issue: IssueRef): string {
  return `${issue.repo}#${issue.number}`.toLowerCase();
}

/** gh で取った issue の状態 */
export interface IssueState {
  /** OPEN / CLOSED */
  state: string;
  /** COMPLETED / NOT_PLANNED / DUPLICATE / REOPENED。理由が記録される前に閉じた issue は空 */
  stateReason: string;
}

export type IssueProgress = 'open' | 'completed' | 'not_completed' | 'unknown';

/**
 * 待つ issue が終わったか
 * completed で閉じたときだけ終わったとみなす。not planned や duplicate は、後続を始めてよいか分からない
 * OPEN と CLOSED 以外（PR の MERGED など）は unknown。黙って待ち続けないよう、呼ぶ側で警告する
 */
export function issueProgress(state: IssueState): IssueProgress {
  const s = state.state.toUpperCase();
  if (s === 'OPEN') return 'open';
  if (s !== 'CLOSED') return 'unknown';
  const reason = state.stateReason.toUpperCase();
  return reason === 'COMPLETED' || reason === '' ? 'completed' : 'not_completed';
}
