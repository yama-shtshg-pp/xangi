/**
 * issue から起動した Claude Code のフック（http）の受け口
 *
 * tmux-launcher が起動する claude に、次の 2 つを呼ばせる。
 * - PreToolUse: `POST /hooks/tool-risk?session=<セッション名>`
 *   危ないと判定したら permissionDecision: "ask" を返し、セッションの中で人に確かめさせる。
 *   --dangerously-skip-permissions 付きでも、フックの ask では確認が出る。
 * - Stop: `POST /hooks/loop-watch?session=<セッション名>`
 *   判定を待たずに空の応答を返し、作業の状態の判定（loop-watch.ts）は裏で行う。
 *
 * Why: チャットの承認サーバー（approval-server.ts）は Discord が有効なときだけ起動し、
 * ポートもほかの xangi と分け合っている。issue のセッション用に、別のポートで待ち受ける。
 * 受け口が落ちていてもフックの失敗として扱われ、Claude Code の作業は止まらない。
 */
import { createServer, type Server } from 'http';
import type { IncomingMessage } from 'http';
import type { LoopWatcher } from './loop-watch.js';
import { toolTarget, type ToolRiskChecker, type ToolRiskVerdict } from './tool-risk.js';

export const DEFAULT_TOOL_RISK_PORT = 18190;
export const TOOL_RISK_PATH = '/hooks/tool-risk';
export const LOOP_WATCH_PATH = '/hooks/loop-watch';

/** PreToolUse のフックの URL。tmux-launcher が --settings に入れる */
export function toolRiskHookUrl(port: number, session: string): string {
  return `http://127.0.0.1:${port}${TOOL_RISK_PATH}?session=${encodeURIComponent(session)}`;
}

/** Stop のフックの URL。tmux-launcher が --settings に入れる */
export function loopWatchHookUrl(port: number, session: string): string {
  return `http://127.0.0.1:${port}${LOOP_WATCH_PATH}?session=${encodeURIComponent(session)}`;
}

/** EVENT_TOOL_RISK_PORT を読む。不正な値なら既定のポート */
export function getToolRiskPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.EVENT_TOOL_RISK_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_TOOL_RISK_PORT;
}

/** フックの応答。許可なら空（ほかのフックと設定の判断に任せる） */
export function buildHookResponse(verdict: ToolRiskVerdict): string {
  if (verdict.decision === 'allow') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `xangi: ${verdict.reasons.join('、')}`,
    },
  });
}

export interface ToolRiskServerOptions {
  /** ツール実行前のリスク判定。未指定なら PreToolUse の受け口は 404 */
  checker?: ToolRiskChecker;
  port: number;
  /** セッション名から issue を引く。分からなければ undefined */
  resolveSession?: (session: string) => { id: string; title: string } | undefined;
  /** ask を返したときに呼ぶ（人に承認を待っていることを知らせる）。失敗しても応答は返す */
  onAsk?: (session: string, verdict: ToolRiskVerdict, target: string) => Promise<void>;
  /** 返答を終えるたびに作業の状態を判定する。未指定なら Stop の受け口は 404 */
  loopWatch?: LoopWatcher;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

export function startToolRiskServer(options: ToolRiskServerOptions): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isToolRisk = url.pathname === TOOL_RISK_PATH && options.checker !== undefined;
    const isLoopWatch = url.pathname === LOOP_WATCH_PATH && options.loopWatch !== undefined;
    if ((!isToolRisk && !isLoopWatch) || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    const reply = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    const session = url.searchParams.get('session') ?? '';
    if (isLoopWatch) {
      try {
        const body = (await readJson(req)) as { last_assistant_message?: unknown };
        // 判定を待たずに応答する（Stop のフックで decision: "block" は返さない）
        reply('{}');
        const issue = options.resolveSession?.(session);
        void options.loopWatch!.handleStop({
          session,
          issueId: issue?.id,
          issueTitle: issue?.title,
          lastMessage:
            typeof body.last_assistant_message === 'string'
              ? body.last_assistant_message
              : undefined,
        });
      } catch (err) {
        console.error(`[loop-watch] ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) reply('{}');
      }
      return;
    }
    try {
      const body = (await readJson(req)) as {
        tool_name?: string;
        tool_input?: Record<string, unknown>;
      };
      const issue = options.resolveSession?.(session);
      const toolName = body.tool_name ?? '';
      const toolInput = body.tool_input ?? {};
      const verdict = await options.checker!.check({
        session,
        issueId: issue?.id,
        issueTitle: issue?.title,
        toolName,
        toolInput,
      });
      reply(buildHookResponse(verdict));
      if (verdict.decision === 'ask' && options.onAsk) {
        options.onAsk(session, verdict, toolTarget(toolName, toolInput)).catch((err) => {
          console.error(
            `[tool-risk-server] Failed to notify: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      // 判定できないときは許可する（フックの失敗で作業を止めない）
      console.error(
        `[tool-risk-server] ${err instanceof Error ? err.message : String(err)}. Allowing the tool`
      );
      if (!res.headersSent) reply('{}');
    }
  });
  server.on('error', (err) => {
    console.error(`[tool-risk-server] ${err.message}`);
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`[tool-risk-server] Listening on http://127.0.0.1:${options.port}`);
  });
  return server;
}
