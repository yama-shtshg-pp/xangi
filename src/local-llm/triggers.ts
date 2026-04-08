/**
 * Triggers — chatモードでマジックワードによる機能発動
 *
 * ワークスペースの triggers/ ディレクトリから trigger.yaml を読み込み、
 * LLM応答テキストからトリガーワードを検出して handler スクリプトを実行する。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);

export interface Trigger {
  name: string;
  trigger: string;
  description: string;
  handler: string;
  /** handler結果をLLMにフィードバックして再応答させるか（デフォルト: false） */
  feedback: boolean;
  /** trigger.yaml が存在するディレクトリの絶対パス */
  path: string;
}

export interface TriggerMatch {
  trigger: Trigger;
  args: string;
}

/**
 * ワークスペースの triggers/ ディレクトリをスキャンして trigger 定義を読み込む。
 * triggers/ が存在しない場合は空配列を返す。
 */
export function loadTriggers(workdir: string): Trigger[] {
  const triggersDir = join(workdir, 'triggers');
  if (!existsSync(triggersDir) || !statSync(triggersDir).isDirectory()) {
    return [];
  }

  const triggers: Trigger[] = [];
  let entries: string[];
  try {
    entries = readdirSync(triggersDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(triggersDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const yamlPath = join(entryPath, 'trigger.yaml');
    if (!existsSync(yamlPath)) continue;

    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;

      if (!parsed.name || !parsed.trigger || !parsed.handler) {
        console.warn(`[triggers] Invalid trigger.yaml in ${entry}: missing required fields`);
        continue;
      }

      triggers.push({
        name: String(parsed.name),
        trigger: String(parsed.trigger),
        description: String(parsed.description || ''),
        handler: String(parsed.handler),
        feedback: parsed.feedback === true,
        path: entryPath,
      });

      console.log(`[triggers] Loaded: ${parsed.trigger} (${parsed.name})`);
    } catch (err) {
      console.warn(
        `[triggers] Failed to parse ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return triggers;
}

/**
 * テキストからトリガーワードを検出する。
 * `!weather 名古屋` のように、トリガーワードの後にスペース区切りで引数が続く形式。
 * テキスト内の任意の行でマッチする。最初にマッチしたものを返す。
 */
export function matchTrigger(text: string, triggers: Trigger[]): TriggerMatch | null {
  if (triggers.length === 0) return null;

  for (const trigger of triggers) {
    // 行ごとにチェック（全角！→半角!に正規化）
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim().replace(/！/g, '!');
      // 完全一致
      if (trimmed === trigger.trigger) {
        return { trigger, args: '' };
      }
      // 行頭一致（引数あり）
      if (trimmed.startsWith(trigger.trigger + ' ')) {
        const args = trimmed.slice(trigger.trigger.length + 1).trim();
        return { trigger, args };
      }
    }
  }

  return null;
}

/**
 * トリガーの handler スクリプトを実行して結果を返す。
 * handler はワークスペースルートを cwd として実行される。
 */
export function executeTrigger(
  trigger: Trigger,
  args: string,
  workdir: string
): Promise<{ success: boolean; output: string }> {
  const handlerPath = join(trigger.path, trigger.handler);

  return new Promise((resolve) => {
    const argv = args ? args.split(/\s+/) : [];
    execFile(
      'bash',
      [handlerPath, ...argv],
      {
        cwd: workdir,
        timeout: EXEC_TIMEOUT_MS,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr || error.message;
          console.error(`[triggers] Handler ${trigger.name} failed: ${errMsg}`);
          resolve({ success: false, output: `Error: ${errMsg}` });
        } else {
          resolve({ success: true, output: stdout });
        }
      }
    );
  });
}

/**
 * トリガー一覧をシステムプロンプト用のテキストに変換する。
 */
export function buildTriggersPrompt(triggers: Trigger[]): string {
  if (triggers.length === 0) return '';

  const lines = triggers.map((t) => `${t.trigger} — ${t.description}`);
  return [
    '## トリガーコマンド',
    '',
    'あなたの返答に以下のコマンドを含めると、システムが自動的に検出して実行します。',
    '',
    lines.join('\n'),
    '',
    '【重要ルール】',
    '- ユーザーのリクエストに該当するコマンドがあれば、自分の知識で答えずにコマンドを使ってください',
    '- コマンドは必ず行の先頭に単独で書いてください。他のテキストと同じ行に混ぜないでください',
    '',
    '良い例:',
    'テックニュースを調べるね！',
    '!technews',
    '',
    '悪い例:',
    '!technews を使って調べるよ！',
  ].join('\n');
}
