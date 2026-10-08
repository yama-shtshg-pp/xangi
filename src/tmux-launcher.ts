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
  options: { env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

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
  /** Claude Code の作業ディレクトリ */
  cwd: string;
  exec?: ExecFileFn;
}

export class TmuxLauncher {
  private exec: ExecFileFn;

  constructor(private options: TmuxLauncherOptions) {
    this.exec = options.exec ?? execFileAsync;
  }

  private run(args: string[]) {
    // tmux のサーバーを xangi が立ち上げた場合も、シークレットを Claude Code に渡さない
    return this.exec(this.options.tmuxPath, args, { env: getSafeEnv() });
  }

  /** 同じ名前の tmux セッションがあるか */
  async hasSession(name: string): Promise<boolean> {
    try {
      // `=` を付けて完全一致で探す（付けないと前方一致で別のセッションに当たる）
      await this.run(['has-session', '-t', `=${name}`]);
      return true;
    } catch (err) {
      // セッションがない・tmux のサーバーが動いていないときは終了コード 1 になる
      if (typeof (err as { code?: unknown }).code === 'number') return false;
      throw err;
    }
  }

  /**
   * tmux の新しいセッションで Claude Code を起動する
   * @returns 起動したら true。同じ名前のセッションがすでにあれば起動せず false
   */
  async launch(name: string, prompt: string): Promise<boolean> {
    if (await this.hasSession(name)) return false;
    await this.run([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      this.options.cwd,
      '--',
      this.options.claudePath,
      '-n',
      name,
      '--remote-control',
      name,
      prompt,
    ]);
    return true;
  }
}
