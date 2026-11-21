/**
 * issue の本文に書いた、先に終わらせる issue（`xangi-run-after: #12, owner/repo#3`）を読む
 *
 * Why: 前の issue が終わってから始める issue は、前の issue が終わったときに `agent` ラベルを付けていた。
 * 付けるよう指示しないと、エージェントは後続の issue を探してラベルを付けない。
 * 本文の 1 行で待つ issue を書き、ラベルは最初から付けておけるようにする。
 */

/** 行頭の `xangi-run-after:` か `待つ:` の値を取る。行が複数あれば、すべての行の issue を待つ */
const RUN_AFTER_LINE = /^(?:xangi-run-after|待つ)[:：][ \t]*(.*?)[ \t]*$/gm;
/** `#12`、`repo#12`、`owner/repo#12` */
const ISSUE_REF = /^(?:([\w.-]+\/[\w.-]+)|([\w.-]+))?#(\d+)$/;
/** issue の URL。末尾の `#issuecomment-…` や `?…` は無視する。PR の URL は読まない */
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:[#?].*)?$/;

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
      const issue = parseIssueRef(ref, repo);
      if (!issue) return { kind: 'invalid', value };
      // リポジトリ名は大文字・小文字を区別しない
      const key = issueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  return found ? { kind: 'valid', issues } : { kind: 'none' };
}

function parseIssueRef(ref: string, repo: string): IssueRef | undefined {
  const url = ISSUE_URL.exec(ref);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const m = ISSUE_REF.exec(ref);
  if (!m) return undefined;
  // `repo#3` の owner は、本文を書いた issue のリポジトリの owner
  const owner = repo.split('/')[0];
  return { repo: m[1] ?? (m[2] ? `${owner}/${m[2]}` : repo), number: Number(m[3]) };
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

/** GitHub の「Blocked by」に指定された issue と、その状態 */
export interface BlockedByIssue {
  issue: IssueRef;
  state: IssueState;
}

/** `gh api --paginate` の出力は、ページごとの配列をつなげたものになる。文字列の中の括弧を数えないよう読み分ける */
function splitJsonArrays(text: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) chunks.push(text.slice(start, i + 1));
    }
  }
  return chunks;
}

/**
 * `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` の出力を読む
 * 読めない出力は例外にする（待つ issue を取りこぼして、早く起動しないため）
 */
export function parseBlockedBy(stdout: string): BlockedByIssue[] {
  const result: BlockedByIssue[] = [];
  const trimmed = stdout.trim();
  if (trimmed === '') return result;
  const chunks = splitJsonArrays(trimmed);
  if (chunks.length === 0) throw new Error('blocked_by response is not a JSON array');
  for (const chunk of chunks) {
    const items = JSON.parse(chunk) as unknown;
    if (!Array.isArray(items)) throw new Error('blocked_by response is not a JSON array');
    for (const item of items as Record<string, unknown>[]) {
      const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(String(item?.repository_url ?? ''))?.[1];
      if (!repo || typeof item.number !== 'number' || typeof item.state !== 'string') {
        throw new Error('blocked_by response has an unexpected item');
      }
      const reason = item.state_reason;
      result.push({
        issue: { repo, number: item.number },
        // gh issue view の値（CLOSED、NOT_PLANNED）と表記をそろえる
        state: {
          state: item.state.toUpperCase(),
          stateReason: typeof reason === 'string' ? reason.toUpperCase() : '',
        },
      });
    }
  }
  return result;
}
