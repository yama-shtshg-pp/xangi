/**
 * Slack で使い方を聞かれたときの早見表と判定（Red 用の雛形。実装はこれから）
 */
import type { RepoTarget } from './event-source-github.js';

export type JevHelpMode = 'off' | 'shadow' | 'on';

export function getJevHelpMode(_env: NodeJS.ProcessEnv = process.env): JevHelpMode {
  throw new Error('not implemented');
}

export const HELP_THRESHOLD = 0;

export function isHelpWord(_text: string): boolean {
  throw new Error('not implemented');
}

export function buildHelpText(_keyTableText: string): string {
  throw new Error('not implemented');
}

export function findHelpWordKeys(_targets: RepoTarget[]): string[] {
  throw new Error('not implemented');
}

export interface HelpJudgement {
  ok: boolean;
  help?: number;
  jevModel?: string;
  latencyMs: number;
  error?: string;
}

export type JudgeHelp = (text: string) => Promise<HelpJudgement>;

export async function judgeHelpRequest(_text: string, _timeoutMs?: number): Promise<HelpJudgement> {
  throw new Error('not implemented');
}

export class HelpChecker {
  constructor(_options: { mode: JevHelpMode; logPath: string; judge?: JudgeHelp }) {
    throw new Error('not implemented');
  }
  get mode(): JevHelpMode {
    throw new Error('not implemented');
  }
  async check(_input: { id: string; text: string }): Promise<boolean> {
    throw new Error('not implemented');
  }
}
