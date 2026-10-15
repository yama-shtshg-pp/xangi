/**
 * ウォッチリスト: GitHub issue から起動するリポジトリを `DATA_DIR/watch-repos.json` で管理する
 *
 * リストには手元のリポジトリのパスを並べる。GitHub のリポジトリ名は、そのパスの git remote から読み取る。
 * ポーリングのたびにファイルを読み直すので、xangi を再起動しなくても追加・削除・無効化が効く。
 *
 * Why: Claude Code を対象リポジトリのパスで起動すれば、そのリポジトリの CLAUDE.md や
 * 品質ゲートが最初から効く。GitHub 名とパスを別々に書くと組み合わせを書き間違えるので、
 * GitHub 名は remote から読み取る。
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { promisify } from 'util';
import type { RepoTarget } from './event-source-github.js';

export const WATCH_REPOS_FILE = 'watch-repos.json';

/** ウォッチリストのパス（index.ts の DATA_DIR と同じ決め方） */
export function getWatchListPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.DATA_DIR || join(env.WORKSPACE_PATH || process.cwd(), '.xangi');
  return join(dataDir, WATCH_REPOS_FILE);
}

export interface WatchRepoEntry {
  /** 手元のリポジトリ（必須。`~` を展開する） */
  path: string;
  /** GitHub 名を読み取る remote（省略時は origin） */
  remote?: string;
  /** owner/repo。書いたときは remote から読み取らない */
  repo?: string;
  label?: string;
  notifyChannelId?: string;
  enabled?: boolean;
}

/** git を実行して標準出力を返す（テストで差し替える） */
export type GitExec = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const defaultGitExec: GitExec = async (args) => {
  const { stdout } = await execFileAsync('git', args, { timeout: 10_000 });
  return stdout;
};

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * remote の URL から owner/repo を読み取る。読み取れなければ undefined
 * - HTTPS: https://github.com/owner/repo.git
 * - SSH: git@github.com:owner/repo.git / git@github-sub:owner/repo.git（別名ホスト）
 * - ssh://git@github.com/owner/repo.git
 */
export function parseGitHubRepo(url: string): string | undefined {
  const trimmed = url.trim();
  let path: string | undefined;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(trimmed);
  if (scp) {
    path = scp[1];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      // HTTPS は別名ホストを使わないので github.com に限る
      if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return undefined;
    } else if (parsed.protocol !== 'ssh:') {
      return undefined;
    }
    path = parsed.pathname;
  }
  const ownerRepo = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return OWNER_REPO.test(ownerRepo) ? ownerRepo : undefined;
}

/** `~` と `~/...` をホームディレクトリに展開する */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function isAtEnd(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/end of JSON input/.test(message)) return true;
    const position = /at position (\d+)/.exec(message);
    return position !== null && Number(position[1]) >= text.length;
  }
}

/**
 * JSON の構文エラーの位置（1 始まりの行と列）を求める
 * 先頭から 1 文字ずつ延ばし、「入力の途中で終わった」以外のエラーになった文字を位置とする。
 * 手で編集する小さなファイルなので、文字数の 2 乗の手間でも問題ない
 */
export function locateJsonError(text: string): { line: number; column: number } {
  let offset = text.length;
  for (let i = 1; i <= text.length; i++) {
    if (!isAtEnd(text.slice(0, i))) {
      offset = i - 1;
      break;
    }
  }
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

const STRING_FIELDS = ['path', 'remote', 'repo', 'label', 'notifyChannelId'] as const;

/**
 * ファイルの中身を検証して項目の一覧を返す
 * @throws JSON として読めない、または形がおかしいとき（どの項目のどこかをメッセージに入れる）
 */
export function parseWatchRepos(text: string): WatchRepoEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // V8 のメッセージには行と列が入らない形もある（例: Unexpected token '}', "..." is not valid JSON）
    if (/\(line \d+ column \d+\)/.test(message)) throw err;
    const { line, column } = locateJsonError(text);
    throw new Error(`${message} (line ${line} column ${column})`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { repos?: unknown }).repos)) {
    throw new Error('"repos" must be an array');
  }
  return (data as { repos: unknown[] }).repos.map((item, i) => {
    const where = `repos[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where} must be an object`);
    }
    const entry = item as Record<string, unknown>;
    for (const field of STRING_FIELDS) {
      const value = entry[field];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`${where}.${field} must be a non-empty string`);
      }
    }
    if (entry.path === undefined) throw new Error(`${where}.path is required`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`${where}.enabled must be true or false`);
    }
    if (typeof entry.repo === 'string' && !OWNER_REPO.test(entry.repo.trim())) {
      throw new Error(`${where}.repo must be owner/repo`);
    }
    return entry as unknown as WatchRepoEntry;
  });
}

export interface WatchRepoDefaults {
  label: string;
  notifyChannelId?: string;
}

export interface WatchRepoListOptions {
  filePath: string;
  defaults: WatchRepoDefaults;
  /** 飛ばした項目を知らせる。同じ内容は 1 回だけ呼ぶ */
  notify: (message: string, channelId?: string) => Promise<void>;
  git?: GitExec;
  home?: string;
}

export class WatchRepoList {
  private git: GitExec;
  /** 通知済みの問題（項目の path と内容）。解消したら消し、再発したらまた通知する */
  private notified = new Set<string>();

  constructor(private options: WatchRepoListOptions) {
    this.git = options.git ?? defaultGitExec;
  }

  exists(): boolean {
    return existsSync(this.options.filePath);
  }

  /**
   * ファイルを読み直し、ポーリングの対象を返す
   * 使えない項目は飛ばして通知する
   * @throws ファイルが読めない・形式がおかしいとき（前回の内容は使わない）
   */
  async load(): Promise<RepoTarget[]> {
    let entries: WatchRepoEntry[];
    try {
      entries = parseWatchRepos(readFileSync(this.options.filePath, 'utf-8'));
    } catch (err) {
      const message = `Failed to read ${this.options.filePath}: ${errorMessage(err)}`;
      // ログだけだと、全リポジトリのポーリングが止まっていることに気づけない
      await this.report(
        new Map([[`\n${message}`, { message, channelId: this.options.defaults.notifyChannelId }]]),
        '⚠️ ウォッチリストを読めないため、GitHub issue のポーリングを止めています'
      );
      throw new Error(message);
    }

    const targets: RepoTarget[] = [];
    const problems: Problems = new Map();
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      const channelId = entry.notifyChannelId?.trim() || this.options.defaults.notifyChannelId;
      const result = await this.resolve(entry);
      if ('error' in result) {
        problems.set(`${entry.path}\n${result.error}`, { message: result.error, channelId });
        continue;
      }
      const { repo } = result;
      // 同じリポジトリを 2 か所から見ると、どちらのパスで起動するかが定まらない
      const duplicate = targets.find((t) => t.repo.toLowerCase() === repo.toLowerCase());
      if (duplicate) {
        const message = `${entry.path}: ${repo} is already watched from ${duplicate.workdir}`;
        problems.set(`${entry.path}\n${message}`, { message, channelId });
        continue;
      }
      targets.push({
        repo,
        label: entry.label?.trim() || this.options.defaults.label,
        workdir: expandHome(entry.path.trim(), this.options.home),
        notifyChannelId: channelId,
      });
    }

    await this.report(problems, '⚠️ ウォッチリストの項目を飛ばしました');
    return targets;
  }

  /** 項目から owner/repo を求める */
  private async resolve(entry: WatchRepoEntry): Promise<{ repo: string } | { error: string }> {
    const path = expandHome(entry.path.trim(), this.options.home);
    if (!isAbsolute(path))
      return { error: `${entry.path}: path must be absolute (or start with ~)` };
    if (!isDirectory(path)) return { error: `${entry.path}: directory not found` };
    try {
      const inside = await this.git(['-C', path, 'rev-parse', '--is-inside-work-tree']);
      if (inside.trim() !== 'true') return { error: `${entry.path}: not a git repository` };
    } catch (err) {
      // タイムアウトなど、git リポジトリでないこと以外の失敗を取り違えないよう、git のエラーをそのまま出す
      return { error: `${entry.path}: git rev-parse failed: ${gitError(err)}` };
    }
    if (entry.repo) return { repo: entry.repo.trim() };

    const remote = entry.remote?.trim() || 'origin';
    let url: string;
    try {
      url = (await this.git(['-C', path, 'remote', 'get-url', remote])).trim();
    } catch (err) {
      return { error: `${entry.path}: git remote get-url ${remote} failed: ${gitError(err)}` };
    }
    const repo = parseGitHubRepo(url);
    if (!repo) {
      return { error: `${entry.path}: cannot read owner/repo from remote "${remote}" (${url})` };
    }
    return { repo };
  }

  /** 新しく出た問題だけを通知する。解消した問題は忘れる */
  private async report(problems: Problems, title: string): Promise<void> {
    for (const key of this.notified) {
      if (!problems.has(key)) this.notified.delete(key);
    }
    for (const [key, { message, channelId }] of problems) {
      console.warn(`[watch-repos] ${message}`);
      if (this.notified.has(key)) continue;
      try {
        await this.options.notify(`${title}: ${message}`, channelId);
        // 送れなかったら、次のポーリングで送り直す
        this.notified.add(key);
      } catch (err) {
        console.error(`[watch-repos] Notify failed: ${errorMessage(err)}`);
      }
    }
  }
}

type Problems = Map<string, { message: string; channelId?: string }>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** git の失敗の理由（stderr の 1 行目。なければエラーメッセージ） */
function gitError(err: unknown): string {
  const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
  return (stderr || errorMessage(err)).split('\n')[0];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
