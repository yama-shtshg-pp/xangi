/**
 * tmux のセッションの中で、対話モードの Claude Code を起動する
 *
 * イベント（GitHub issue）ごとに `cc-<リポジトリ名>-issue<番号>` という tmux セッションを作り、
 * `claude -n <名前> --remote-control <名前> <プロンプト>` を動かす。
 * 起動したあとのやり取りは、人が `tmux attach` か Remote Control から Claude Code と直接行う。
 * xangi はセッションの有無だけを見て、起動中か終了かを判断する。
 *
 * Why: issue の本文には引用符や `$()` が入りうる。シェルを通すと本文の一部がコマンドとして
 * 実行されるおそれがあるので、tmux には引数を配列で渡す（tmux は引数が 2 つ以上なら
 * シェルを通さずに実行する）。`claude` もエイリアスを通さないよう、絶対パスで起動する。
 */
import { execFile } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, join, resolve } from 'path';
import { promisify } from 'util';
import type { AgentEvent } from './event-store.js';
import { getSafeEnv } from './safe-env.js';

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

/** tmux の呼び出しの上限。tmux が固まってもポーリング全体を止めない */
const TMUX_TIMEOUT_MS = 10_000;
/** 起動してから、claude がすぐに終了していないかを確かめるまでの時間 */
const DEFAULT_STARTUP_CHECK_MS = 5_000;

/** has-session が「セッションがない」ときに出すメッセージ（ほかのエラーと見分ける） */
const NO_SESSION_PATTERNS = [
  /can't find session/,
  /no server running/,
  /error connecting to .*\(No such file or directory\)/,
];

const execFileAsync: ExecFileFn = promisify(execFile);

/** tmux のセッション名に使えない文字（`.` と `:` など）を `-` に置き換える */
function sanitize(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** イベントの ID（例: owner/repo#12）から tmux のセッション名（例: cc-repo-issue12）を作る */
export function toSessionName(event: Pick<AgentEvent, 'id'>): string {
  const match = /([^/#]+)#(\d+)$/.exec(event.id);
  if (match) return `cc-${sanitize(match[1])}-issue${match[2]}`;
  return `cc-${sanitize(event.id)}`;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * コマンドの絶対パスを返す。見つからなければ undefined
 * `/` を含む指定はそのパスを、含まなければ PATH を順に探す
 */
export function resolveCommandPath(
  command: string,
  pathEnv: string | undefined = process.env.PATH,
  canExecute: (path: string) => boolean = isExecutable
): string | undefined {
  if (command.includes('/')) {
    const path = resolve(command);
    return canExecute(path) ? path : undefined;
  }
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, command);
    if (canExecute(path)) return path;
  }
  return undefined;
}

export interface TmuxLauncherOptions {
  tmuxPath: string;
  claudePath: string;
  /** Claude Code の作業ディレクトリ（launch で指定がないとき） */
  cwd: string;
  /** セッションの PATH（GitHub App のラッパーを含める）。未指定なら getSafeEnv() の PATH */
  sessionPath?: string;
  /** 起動してから、すぐに終了していないかを確かめるまでの時間 */
  startupCheckMs?: number;
  exec?: ExecFileFn;
  sleep?: (ms: number) => Promise<void>;
}

export class TmuxLauncher {
  private exec: ExecFileFn;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: TmuxLauncherOptions) {
    this.exec = options.exec ?? execFileAsync;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private run(args: string[]) {
    // tmux のクライアントに渡す環境変数。tmux のサーバーを xangi が立ち上げる場合に、
    // xangi のシークレットをサーバーへ持ち込まない。
    // 新しいセッションの PATH はクライアントのものになり、ほかの変数はサーバーのものを引き継ぐ
    const env = getSafeEnv();
    if (this.options.sessionPath) env.PATH = this.options.sessionPath;
    // TMUX_TMPDIR が違うと別のサーバーに接続し、人が `tmux attach` で見つけられなくなる
    if (process.env.TMUX_TMPDIR) env.TMUX_TMPDIR = process.env.TMUX_TMPDIR;
    return this.exec(this.options.tmuxPath, args, { env, timeout: TMUX_TIMEOUT_MS });
  }

  /** 同じ名前の tmux セッションがあるか */
  async hasSession(name: string): Promise<boolean> {
    try {
      // `=` を付けて完全一致で探す（付けないと前方一致で別のセッションに当たる）
      await this.run(['has-session', '-t', `=${name}`]);
      return true;
    } catch (err) {
      // セッションがない・サーバーが動いていないときだけ false。ほかのエラーを「閉じた」と取り違えない
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      if (NO_SESSION_PATTERNS.some((pattern) => pattern.test(stderr))) return false;
      throw err;
    }
  }

  /**
   * tmux の新しいセッションで Claude Code を起動する
   * @param cwd 作業ディレクトリ。未指定なら options.cwd
   * @returns 起動したら true。同じ名前のセッションがすでにあれば起動せず false
   * @throws claude が起動してすぐに終了したとき（認証エラーなど）
   */
  async launch(name: string, prompt: string, cwd: string = this.options.cwd): Promise<boolean> {
    if (await this.hasSession(name)) return false;
    await this.run([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      '--',
      this.options.claudePath,
      '-n',
      name,
      '--remote-control',
      name,
      prompt,
    ]);
    // new-session はセッションを作った時点で成功する。すぐに終わったものを「人が閉じた」と取り違えない
    await this.sleep(this.options.startupCheckMs ?? DEFAULT_STARTUP_CHECK_MS);
    if (!(await this.hasSession(name))) {
      throw new Error(
        `claude exited right after launch. Run it in ${cwd} by hand to see the error`
      );
    }
    return true;
  }
}
