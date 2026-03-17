/**
 * ローカルLLMバックエンド — xangi本体に統合
 *
 * Ollama等のOpenAI互換APIを直接叩いてエージェントループを実行する。
 * 外部HTTPサーバー不要。
 */
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage } from './types.js';
import { LLMClient } from './llm-client.js';
import { loadWorkspaceContext } from './context.js';
import { getBuiltinTools, toLLMTools, executeTool } from './tools.js';
import { loadSkills } from '../skills.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_SESSION_MESSAGES = 50;

/** セッション（会話履歴） */
interface Session {
  messages: LLMMessage[];
  updatedAt: number;
}

export class LocalLlmRunner implements AgentRunner {
  private readonly llm: LLMClient;
  private readonly workdir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTtlMs = 60 * 60 * 1000; // 1時間

  constructor(config: AgentConfig) {
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.LOCAL_LLM_MODEL || config.model || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || '';
    const thinking = process.env.LOCAL_LLM_THINKING !== 'false';
    const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS
      ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10)
      : 8192;

    this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens);
    this.workdir = config.workdir || process.cwd();

    console.log(`[local-llm] LLM: ${baseUrl} (model: ${model}, thinking: ${thinking})`);
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();
    const tools = getBuiltinTools();
    const llmTools = toLLMTools(tools);

    // ユーザーメッセージ追加
    const userMsg: LLMMessage = { role: 'user', content: prompt };
    session.messages.push(userMsg);

    let toolRounds = 0;
    let finalContent = '';

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      const response = await this.llm.chat(session.messages, {
        systemPrompt,
        tools: llmTools.length > 0 ? llmTools : undefined,
      });

      if (
        response.finishReason === 'stop' ||
        !response.toolCalls ||
        response.toolCalls.length === 0
      ) {
        finalContent = response.content;
        session.messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // ツール呼び出し
      session.messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      });

      const toolContext = { workspace: this.workdir, channelId: options?.channelId };

      for (const toolCall of response.toolCalls) {
        const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
        const toolResultContent = result.success
          ? result.output
          : `Error: ${result.error ?? 'Unknown error'}${result.output ? `\nOutput: ${result.output}` : ''}`;

        session.messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
        });
      }

      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        finalContent = 'Maximum tool rounds reached.';
        break;
      }
    }

    this.trimSession(session);
    session.updatedAt = Date.now();

    return { result: finalContent, sessionId };
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();

    session.messages.push({ role: 'user', content: prompt });

    try {
      let fullText = '';
      for await (const chunk of this.llm.chatStream(session.messages, { systemPrompt })) {
        fullText += chunk;
        callbacks.onText?.(chunk, fullText);
      }

      session.messages.push({ role: 'assistant', content: fullText });
      this.trimSession(session);
      session.updatedAt = Date.now();

      const result: RunResult = { result: fullText, sessionId };
      callbacks.onComplete?.(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError?.(error);
      throw error;
    }
  }

  cancel(): boolean {
    return true;
  }

  destroy(channelId: string): boolean {
    // channelId をセッションIDとして使ってるなら削除
    this.sessions.delete(channelId);
    return true;
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // ワークスペースコンテキスト（CLAUDE.md, AGENTS.md, MEMORY.md）
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

    // スキル一覧
    const skills = loadSkills(this.workdir);
    if (skills.length > 0) {
      const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
      parts.push(`## Available Skills\n${skillList}`);
    }

    return parts.join('\n\n');
  }

  private getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { messages: [], updatedAt: Date.now() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private trimSession(session: Session): void {
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
