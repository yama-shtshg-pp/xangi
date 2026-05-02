import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { createAgentRunner, getBackendDisplayName } from './agent-runner.js';
import type { AgentConfig, Config, EffortLevel } from './config.js';
import { BackendResolver, type ResolvedBackend } from './backend-resolver.js';
import { RunnerManager } from './runner-manager.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { deleteSession } from './sessions.js';
import type { ChatPlatform } from './prompts/index.js';
import { routeModel, type RoutedModel } from './router.js';

/**
 * チャンネルごとにバックエンドを動的に切り替えるランナーマネージャー
 *
 * BackendResolver で解決したバックエンド設定に基づいて、
 * 適切な AgentRunner にリクエストをルーティングする。
 *
 * - claude-code (persistent): RunnerManager で管理（チャンネル別プロセス）
 * - claude-code (non-persistent): 共有 ClaudeCodeRunner
 * - codex / gemini / local-llm: バックエンド種別ごとの共有インスタンス
 */
export class DynamicRunnerManager implements AgentRunner {
  private resolver: BackendResolver;
  private config: Config;
  private platform?: ChatPlatform;

  /** デフォルトのランナー（.env設定ベース） */
  private defaultRunner: AgentRunner;

  /** チャンネル別に生成したランナー（デフォルトと異なるバックエンドの場合） */
  private channelRunners = new Map<string, { runner: AgentRunner; key: string }>();

  constructor(config: Config, resolver: BackendResolver) {
    this.config = config;
    this.resolver = resolver;
    this.platform = config.agent.platform;

    // デフォルトランナーを作成
    this.defaultRunner = createAgentRunner(config.agent.backend, config.agent.config, {
      platform: this.platform,
    });

    console.log(
      `[dynamic-runner] Initialized with default backend: ${getBackendDisplayName(config.agent.backend)}`
    );
  }

  /**
   * チャンネルに対応するランナーを取得
   * resolvedBackendがデフォルトと同じならデフォルトランナーを返す
   */
  private getRunner(channelId: string | undefined, resolved: ResolvedBackend): AgentRunner {
    if (!channelId) return this.defaultRunner;

    // デフォルトと同じなら共有ランナーを使用
    const resolverKey = this.makeKey(resolved);
    const defaultKey = this.makeKey(this.resolver.getDefault());

    if (resolverKey === defaultKey && !resolved.effort) {
      // チャンネル用の別ランナーがあれば破棄
      this.destroyChannelRunner(channelId);
      return this.defaultRunner;
    }

    // 既存のチャンネルランナーがあり、キーが一致すればそれを使う
    const existing = this.channelRunners.get(channelId);
    if (existing && existing.key === resolverKey + (resolved.effort ?? '')) {
      return existing.runner;
    }

    // 既存のチャンネルランナーを破棄
    this.destroyChannelRunner(channelId);

    // 新しいランナーを作成
    const runner = this.createRunnerFor(resolved, channelId);
    this.channelRunners.set(channelId, {
      runner,
      key: resolverKey + (resolved.effort ?? ''),
    });

    console.log(
      `[dynamic-runner] Created channel runner for ${channelId}: ${getBackendDisplayName(resolved.backend)}` +
        (resolved.model ? ` (${resolved.model})` : '') +
        (resolved.effort ? ` effort=${resolved.effort}` : '')
    );

    return runner;
  }

  /**
   * ResolvedBackendから適切なランナーを作成
   */
  private createRunnerFor(resolved: ResolvedBackend, _channelId?: string): AgentRunner {
    const agentConfig: AgentConfig = {
      ...this.config.agent.config,
      model: resolved.model ?? this.config.agent.config.model,
    };

    // claude-code persistent モード: effort付きの専用RunnerManagerを作成
    if (resolved.backend === 'claude-code' && agentConfig.persistent) {
      return new RunnerManager(agentConfig, {
        maxProcesses: agentConfig.maxProcesses,
        idleTimeoutMs: agentConfig.idleTimeoutMs,
        platform: this.platform,
        effort: resolved.effort,
      });
    }

    return createAgentRunner(resolved.backend, agentConfig, {
      platform: this.platform,
    });
  }

  private makeKey(resolved: ResolvedBackend): string {
    return `${resolved.backend}:${resolved.model ?? 'default'}`;
  }

  private destroyChannelRunner(channelId: string): void {
    const existing = this.channelRunners.get(channelId);
    if (existing) {
      existing.runner.destroy?.(channelId);
      // RunnerManagerならshutdownも呼ぶ
      if (
        'shutdown' in existing.runner &&
        typeof (existing.runner as RunnerManager).shutdown === 'function'
      ) {
        (existing.runner as RunnerManager).shutdown();
      }
      this.channelRunners.delete(channelId);
      console.log(`[dynamic-runner] Destroyed channel runner for ${channelId}`);
    }
  }

  /**
   * リクエストを実行
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const channelId = options?.channelId;
    const resolved = this.resolver.resolve(channelId);

    const routed = this.tryRouteModel(prompt, resolved, options);
    if (routed) {
      return this.runWithRoutedModel(prompt, routed, resolved.effort, options);
    }

    const runner = this.getRunner(channelId, resolved);

    // effort をオプションに注入（per-request型のclaude-codeで使用）
    const runOptions = resolved.effort ? { ...options, effort: resolved.effort } : options;

    return runner.run(prompt, runOptions);
  }

  /**
   * ストリーミング実行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId;
    const resolved = this.resolver.resolve(channelId);

    const routed = this.tryRouteModel(prompt, resolved, options);
    if (routed) {
      return this.runStreamWithRoutedModel(prompt, callbacks, routed, resolved.effort, options);
    }

    const runner = this.getRunner(channelId, resolved);

    const runOptions = resolved.effort ? { ...options, effort: resolved.effort } : options;

    return runner.runStream(prompt, callbacks, runOptions);
  }

  /**
   * ルーティングで上書きされた model を ad-hoc な ClaudeCodeRunner で実行する。
   *
   * Why: persistent runner はプロセス起動時に model 固定で立ち上がるため、
   * メッセージ単位で model を切り替えるには毎回 spawn するしかない。
   * 本流チャンネルの session を汚さないよう sessionId は新規発行し、
   * 戻り値の sessionId は呼び出し元から渡された値で上書きする。
   * effort はチャンネル override（resolved.effort）を引き継いで一貫性を保つ。
   */
  private async runWithRoutedModel(
    prompt: string,
    model: RoutedModel,
    effort: EffortLevel | undefined,
    options?: RunOptions
  ): Promise<RunResult> {
    const runner = this.createAdhocClaudeCodeRunner(model);
    const adhocOptions: RunOptions = {
      ...options,
      sessionId: undefined,
      effort: effort ?? options?.effort,
    };
    console.log(`[dynamic-runner] Routed to ${model} (ad-hoc, no session)`);
    const result = await runner.run(prompt, adhocOptions);
    return {
      result: result.result,
      sessionId: options?.sessionId ?? '',
    };
  }

  private async runStreamWithRoutedModel(
    prompt: string,
    callbacks: StreamCallbacks,
    model: RoutedModel,
    effort: EffortLevel | undefined,
    options?: RunOptions
  ): Promise<RunResult> {
    const runner = this.createAdhocClaudeCodeRunner(model);
    const adhocOptions: RunOptions = {
      ...options,
      sessionId: undefined,
      effort: effort ?? options?.effort,
    };
    // 本流セッション保護: ad-hoc 実行で発火する onComplete の sessionId も
    // 呼び出し元の sessionId に置換する（web-chat 等の永続化先で本流が上書きされるのを防ぐ）
    const protectedSessionId = options?.sessionId ?? '';
    const onComplete = callbacks.onComplete;
    const wrappedCallbacks: StreamCallbacks = {
      ...callbacks,
      onComplete: onComplete
        ? (result: RunResult) =>
            onComplete({
              result: result.result,
              sessionId: protectedSessionId,
            })
        : undefined,
    };
    console.log(`[dynamic-runner] Routed to ${model} (ad-hoc stream, no session)`);
    const result = await runner.runStream(prompt, wrappedCallbacks, adhocOptions);
    return {
      result: result.result,
      sessionId: protectedSessionId,
    };
  }

  /**
   * ルーティング判定（前段）。
   *
   * 適用条件:
   * - 呼び出し元が skipRouting を指定していない
   *   （自動エラーフォローアップ等、既存セッションでの続報を保証したいケース）
   * - claude-code バックエンド限定
   * - 実効 model が opus 系でない
   *   （`opus` 短縮形・`claude-opus-*` フル ID の双方を弾くため部分一致）
   * - 振り分け先 model が ALLOWED_MODELS で許可されている
   *   （管理者がコスト制御で禁止したモデルへの迂回を防ぐ）
   *
   * Why: /model set で opus 固定したチャンネルは persistent セッション継続が意図。
   * 既に opus で走っているチャンネルを ad-hoc 経路へ迂回させると文脈が失われる。
   * resolved.model が undefined のとき（backend-only override 等）は AGENT_MODEL に
   * フォールバックするため、createRunnerFor() と同じ解決順で実効 model を判定する。
   */
  private tryRouteModel(
    prompt: string,
    resolved: ResolvedBackend,
    options?: RunOptions
  ): RoutedModel | undefined {
    if (options?.skipRouting) return undefined;
    if (resolved.backend !== 'claude-code') return undefined;
    const effectiveModel = resolved.model ?? this.config.agent.config.model;
    if (effectiveModel?.toLowerCase().includes('opus')) return undefined;
    const model = routeModel(prompt);
    if (!model) return undefined;
    if (!this.resolver.isModelAllowed(model)) return undefined;
    return model;
  }

  private createAdhocClaudeCodeRunner(model: RoutedModel): ClaudeCodeRunner {
    const adhocConfig: AgentConfig = {
      ...this.config.agent.config,
      model,
      persistent: false,
    };
    return new ClaudeCodeRunner({ ...adhocConfig, platform: this.platform });
  }

  /**
   * キャンセル
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const channelEntry = this.channelRunners.get(channelId);
      if (channelEntry?.runner.cancel) {
        return channelEntry.runner.cancel(channelId);
      }
    }
    return this.defaultRunner.cancel?.(channelId) ?? false;
  }

  /**
   * 指定チャンネルのランナーを破棄
   */
  destroy(channelId: string): boolean {
    // チャンネル専用ランナーがあれば破棄
    const hadChannelRunner = this.channelRunners.has(channelId);
    this.destroyChannelRunner(channelId);

    // デフォルトランナーにもdestroy（RunnerManagerのプール内エントリ削除）
    const defaultDestroyed = this.defaultRunner.destroy?.(channelId) ?? false;

    return hadChannelRunner || defaultDestroyed;
  }

  /**
   * バックエンド切り替え
   * セッション削除とランナー破棄を行い、次回リクエスト時に新しいランナーが作成される
   */
  switchBackend(channelId: string): void {
    deleteSession(channelId);
    this.destroyChannelRunner(channelId);
    this.defaultRunner.destroy?.(channelId);
    console.log(`[dynamic-runner] Backend switched for channel ${channelId}`);
  }

  /**
   * チャンネルの現在のバックエンド設定を取得
   */
  resolveForChannel(channelId?: string): ResolvedBackend {
    return this.resolver.resolve(channelId);
  }

  /**
   * プール状態の取得（デバッグ・ステータス表示用）
   */
  getStatus(): {
    defaultBackend: string;
    channelRunners: Array<{ channelId: string; key: string }>;
    defaultRunnerStatus?: ReturnType<RunnerManager['getStatus']>;
  } {
    const channelInfo = Array.from(this.channelRunners.entries()).map(([channelId, entry]) => ({
      channelId,
      key: entry.key,
    }));

    return {
      defaultBackend: getBackendDisplayName(this.config.agent.backend),
      channelRunners: channelInfo,
      defaultRunnerStatus:
        'getStatus' in this.defaultRunner
          ? (this.defaultRunner as RunnerManager).getStatus()
          : undefined,
    };
  }

  /**
   * 全ランナーをシャットダウン
   */
  shutdown(): void {
    for (const [channelId, entry] of this.channelRunners.entries()) {
      entry.runner.destroy?.(channelId);
      if (
        'shutdown' in entry.runner &&
        typeof (entry.runner as RunnerManager).shutdown === 'function'
      ) {
        (entry.runner as RunnerManager).shutdown();
      }
    }
    this.channelRunners.clear();

    if (
      'shutdown' in this.defaultRunner &&
      typeof (this.defaultRunner as RunnerManager).shutdown === 'function'
    ) {
      (this.defaultRunner as RunnerManager).shutdown();
    }
  }
}
