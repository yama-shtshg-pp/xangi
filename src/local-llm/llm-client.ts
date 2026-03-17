/**
 * OpenAI互換 + Ollama ネイティブAPI 対応 LLMクライアント
 */
import type { LLMMessage, LLMToolCall, LLMChatOptions, LLMChatResponse } from './types.js';

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
  return messages.map((msg) => {
    const m: OpenAIMessage = { role: msg.role, content: msg.content };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      m.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      m.content = null;
    }
    if (msg.toolCallId) {
      m.tool_call_id = msg.toolCallId;
    }
    return m;
  });
}

export class LLMClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string = '',
    private readonly thinking: boolean = true,
    private readonly defaultMaxTokens: number = 8192
  ) {}

  async chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResponse> {
    if (!this.thinking && this.isOllamaUrl()) {
      return this.chatOllamaNative(messages, options);
    }
    return this.chatOpenAI(messages, options);
  }

  private isOllamaUrl(): boolean {
    return this.baseUrl.includes('11434') || this.baseUrl.includes('ollama');
  }

  private async chatOllamaNative(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): Promise<LLMChatResponse> {
    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (options?.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      think: false,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    body.options = {
      num_predict: options?.maxTokens ?? this.defaultMaxTokens,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
      done_reason?: string;
    };

    const toolCalls: LLMToolCall[] = [];
    if (data.message.tool_calls) {
      for (const tc of data.message.tool_calls) {
        toolCalls.push({
          id: crypto.randomUUID(),
          name: tc.function.name,
          arguments: tc.function.arguments ?? {},
        });
      }
    }

    let finishReason: LLMChatResponse['finishReason'] = 'stop';
    if (toolCalls.length > 0) finishReason = 'tool_calls';
    else if (data.done_reason === 'length') finishReason = 'length';

    return {
      content: data.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  private async chatOpenAI(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): Promise<LLMChatResponse> {
    const requestMessages = toOpenAIMessages(messages);

    if (options?.systemPrompt) {
      requestMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: requestMessages,
      stream: false,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error('No choices in LLM response');

    const toolCalls: LLMToolCall[] = [];
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = { raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id || crypto.randomUUID(),
          name: tc.function.name,
          arguments: args,
        });
      }
    }

    let finishReason: LLMChatResponse['finishReason'] = 'stop';
    if (choice.finish_reason === 'tool_calls') finishReason = 'tool_calls';
    else if (choice.finish_reason === 'length') finishReason = 'length';

    // Thinking model: content が空で reasoning に推論が入ることがある
    let content = choice.message.content ?? '';
    if (!content && choice.message.reasoning) {
      content = choice.message.reasoning;
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
    };
  }

  async *chatStream(messages: LLMMessage[], options?: LLMChatOptions): AsyncGenerator<string> {
    // Thinking model + Ollama → ネイティブAPIでストリーミング（think:false対応）
    if (!this.thinking && this.isOllamaUrl()) {
      yield* this.chatStreamOllamaNative(messages, options);
      return;
    }

    const requestMessages = toOpenAIMessages(messages);

    if (options?.systemPrompt) {
      requestMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: requestMessages,
      stream: true,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
    };

    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LLM API error ${response.status}: ${await response.text()}`);
    }

    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasContent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const chunk = JSON.parse(trimmed.slice(6)) as {
                choices: Array<{ delta: { content?: string; reasoning?: string } }>;
              };
              const delta = chunk.choices[0]?.delta;
              if (delta?.content) {
                hasContent = true;
                yield delta.content;
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Thinking model でcontentが空だった場合、non-streamingにフォールバック
    if (!hasContent) {
      const result = await this.chat(messages, options);
      if (result.content) yield result.content;
    }
  }

  /**
   * Ollama ネイティブ API (/api/chat) でストリーミング（think:false対応）
   */
  private async *chatStreamOllamaNative(
    messages: LLMMessage[],
    options?: LLMChatOptions
  ): AsyncGenerator<string> {
    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (options?.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: true,
      think: false,
    };

    body.options = {
      num_predict: options?.maxTokens ?? this.defaultMaxTokens,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }

    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            if (chunk.message?.content) {
              yield chunk.message.content;
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
