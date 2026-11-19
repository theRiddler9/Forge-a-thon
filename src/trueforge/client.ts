import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { TrueForgeClientConfig, TrueForgeModelInfo, TurnMetrics, TurnStreamCallbacks } from './types.js';

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class TrueForgeClient {
  private config: TrueForgeClientConfig;
  private sdkClient: TrueForge;
  private activeModel: string;
  private abortControllers = new Map<string, AbortController>();
  public lastFallbackInfo: { from: string; to: string; attempts: number; maxRetries: number } | null = null;

  constructor(config: TrueForgeClientConfig) {
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      ...config,
      baseUrl: config.baseUrl ?? (config as any).serverUrl ?? 'http://localhost:8790',
    };
    this.activeModel = this.config.primaryModel;
    this.sdkClient = new TrueForge({
      baseUrl: this.config.baseUrl,
      timeoutInSeconds: 600,
    });
  }

  getActiveModel(): string {
    return this.activeModel;
  }

  setActiveModel(model: string): void {
    this.activeModel = model;
    this.lastFallbackInfo = null;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  getPrimaryModel(): string {
    return this.config.primaryModel;
  }

  getFallbackModel(): string | undefined {
    return this.config.fallbackModel;
  }

  hasFallback(): boolean {
    return (
      !!this.config.fallbackModel && this.config.fallbackModel !== this.config.primaryModel
    );
  }

  markFallbackActivated(): void {
    this.activeModel = this.config.fallbackModel!;
    this.lastFallbackInfo = {
      from: this.config.primaryModel,
      to: this.config.fallbackModel!,
      attempts: 1,
      maxRetries: 1,
    };
  }

  /**
   * Runs a single turn and resolves with the final turn status.
   * Unlike streamTurn, this always resolves (never throws), which lets call
   * sites implement automatic model fallback on turn-time failures.
   */
  async runTurn(
    sessionId: string,
    userMessage: string,
    callbacks: TurnStreamCallbacks = {}
  ): Promise<{ status: string; message?: string; metrics?: TurnMetrics }> {
    return new Promise((resolve) => {
      const wrapped: TurnStreamCallbacks = {
        ...callbacks,
        onDone: (status, message, metrics) => {
          callbacks.onDone?.(status, message, metrics);
          resolve({ status, message, metrics });
        },
        onError: (err: Error) => {
          callbacks.onError?.(err);
          resolve({ status: 'error', message: err?.message ?? String(err) });
        },
      };
      this.streamTurn(sessionId, userMessage, wrapped).catch((err: any) => {
        callbacks.onError?.(err);
        resolve({ status: 'error', message: err?.message ?? String(err) });
      });
    });
  }

  async listModelsDetailed(): Promise<TrueForgeModelInfo[]> {
    try {
      const res = await this.sdkClient.models.list();
      const list = (res.data?.map((m: any) => {
        const props = m.properties ?? {};
        const contextLength = num(props.context_length ?? props.contextLength);
        const maxOutputTokens = num(props.max_output_tokens ?? props.maxOutputTokens);
        return {
          name: m.name || m.id,
          ...(contextLength !== undefined ? { contextLength } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        };
      }) || []).filter((m) => m.name);
      if (list.length > 0 && (!this.activeModel || !list.some((m) => m.name === this.activeModel))) {
        this.activeModel = list[0].name;
      }
      return list;
    } catch (err: any) {
      console.warn(`Could not fetch models from TrueForge: ${err.message}`);
      return [];
    }
  }

  async listAvailableModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.name);
  }

  async registerMcpServer(name: string, url: string): Promise<boolean> {
    try {
      await (this.sdkClient.settings.mcpServers as any).createOrUpdate({
        manifest: {
          name,
          type: 'remote',
          description: 'ForgePilot in-process editor tools',
          url,
        },
      });
      return true;
    } catch (err: any) {
      console.warn(`Could not register MCP server in TrueForge settings: ${err.message}`);
      return false;
    }
  }

  async createSession(modelName: string, instructions: string): Promise<any> {
    const mcpServerName = this.config.mcpServerName ?? 'forgepilot';

    const sessionPayload: any = {
      agent: {
        spec: {
          model: { name: modelName },
          instructions,
          mcpServers: [
            {
              name: mcpServerName,
              enableTools: ['@all'],
              requireApprovalForTools: ['@destructive', '@write', 'propose_write', 'run_command'],
              preload: false,
              preloadTools: ['list_dir', 'read_file', 'search_text', 'find_symbol', 'get_context_budget_info', 'propose_write'],
            },
          ],
        },
      },
    };

    const response = await this.sdkClient.sessions.create(sessionPayload);
    return response.data;
  }

  async createSessionWithFallback(instructions: string): Promise<any> {
    const maxRetries = this.config.maxRetries ?? 3;
    let delay = this.config.retryDelayMs ?? 1000;
    this.lastFallbackInfo = null;

    // Attempt primary model with backoff
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const session = await this.createSession(this.config.primaryModel, instructions);
        this.activeModel = this.config.primaryModel;
        return session;
      } catch (err: any) {
        console.warn(`Primary model attempt ${attempt} failed: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2;
        }
      }
    }

    // Fallback to secondary model if configured
    if (this.config.fallbackModel && this.config.fallbackModel !== this.config.primaryModel) {
      console.info(`Falling back to secondary model: ${this.config.fallbackModel}`);
      try {
        const session = await this.createSession(this.config.fallbackModel, instructions);
        this.activeModel = this.config.fallbackModel;
        this.lastFallbackInfo = {
          from: this.config.primaryModel,
          to: this.config.fallbackModel,
          attempts: maxRetries,
          maxRetries,
        };
        return session;
      } catch (fallbackErr: any) {
        throw new Error(
          `Both primary model (${this.config.primaryModel}) and fallback model (${this.config.fallbackModel}) failed: ${fallbackErr.message}`
        );
      }
    }

    throw new Error(`Failed to create session with primary model: ${this.config.primaryModel}`);
  }

  async streamTurn(
    sessionId: string,
    userMessage: string,
    callbacks: TurnStreamCallbacks = {}
  ): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    try {
      const stream = await this.sdkClient.sessions.createTurnStream(
        sessionId,
        {
          input: [{ type: 'user.message', content: userMessage }],
        },
        { abortSignal: abortController.signal }
      );

      const eventsMap = new Map<string, any>();

      for await (const { data: event, id } of stream.withMetadata()) {
        if (abortController.signal.aborted) {
          break;
        }

        if (isEventDelta(event)) {
          let existing = eventsMap.get(event.id);
          if (!existing) {
            existing = { id: event.id, type: 'model.message', content: '', toolCalls: [] };
            eventsMap.set(event.id, existing);
          }
          mergeEventDelta(existing, event);

          // Reasoning models (e.g. gpt-oss) stream reasoningContent deltas
          // separately from content deltas. TrueForge flattens the OpenAI
          // shape, so the text lives at the TOP level of the delta event.
          const anyEvent = event as any;
          if (typeof anyEvent.content === 'string' && anyEvent.content.length > 0) {
            if (callbacks.onDelta) {
              callbacks.onDelta(anyEvent.content, event.id);
            }
          }
          if (typeof anyEvent.reasoningContent === 'string' && anyEvent.reasoningContent.length > 0) {
            if (callbacks.onReasoningDelta) {
              callbacks.onReasoningDelta(anyEvent.reasoningContent, event.id);
            }
          }
        } else {
          eventsMap.set(event.id, event);
        }

        if (callbacks.onEvent) {
          callbacks.onEvent(event, id ?? 0);
        }

        // Check for tool approval requirement
        if ((event as any).type === 'tool.approval_required') {
          const rawCalls = (event as any).toolCalls ?? (event as any).tool_calls ?? [];
          const callsList = Array.isArray(rawCalls) && rawCalls.length > 0 ? rawCalls : [(event as any)];
          for (const call of callsList) {
            const toolCallId = call.id ?? (event as any).toolCallId;
            const sourceEventId = call.sourceEventId ?? call.source_event_id ?? (event as any).sourceEventId;
            const sourceEvent = eventsMap.get(sourceEventId);
            const rawTools = sourceEvent?.toolCalls ?? sourceEvent?.tool_calls ?? [];
            const toolCall = rawTools.find((tc: any) => tc.id === toolCallId);
            const toolName = toolCall?.name ?? toolCall?.function?.name ?? 'unknown';
            let toolArgs = toolCall?.arguments ?? toolCall?.function?.arguments ?? {};
            if (typeof toolArgs === 'string') {
              try {
                toolArgs = JSON.parse(toolArgs);
              } catch {
                toolArgs = {};
              }
            }
            if (callbacks.onToolApprovalRequired) {
              callbacks.onToolApprovalRequired(toolCallId, toolName, toolArgs);
            }
          }
        }

        // Check for turn completion
        if ((event as any).type === 'turn.done') {
          const status = (event as any).state?.status ?? 'done';
          const message = (event as any).state?.message as string | undefined;
          const rawMetrics = (event as any).state?.metrics;
          const metrics: TurnMetrics | undefined = rawMetrics
            ? {
                inputTokens: num(rawMetrics.totalInputTokens),
                outputTokens: num(rawMetrics.totalOutputTokens),
                totalTokens: num(rawMetrics.totalTokens),
              }
            : undefined;
          if (callbacks.onDone) {
            callbacks.onDone(status, message, metrics);
          }
        }
      }
    } catch (err: any) {
      if (!abortController.signal.aborted) {
        if (callbacks.onError) {
          callbacks.onError(err);
        } else {
          throw err;
        }
      }
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }

    try {
      await this.sdkClient.sessions.cancel(sessionId);
      return true;
    } catch {
      return true; // Abort signal already guarantees client stop
    }
  }

  async resumeApproval(
    sessionId: string,
    toolCallId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): Promise<any> {
    const approvalPayload: any = {
      type: 'user.tool_approval',
      toolCallId,
      threadId: 'main',
      approval: decision === 'allow' ? { status: 'allow' } : { status: 'deny', reason },
    };

    try {
      return await this.sdkClient.sessions.createTurn(sessionId, {
        input: [approvalPayload],
      });
    } catch (err: any) {
      try {
        const turns = await this.sdkClient.sessions.listTurns(sessionId);
        const lastTurnId = turns.data?.[0]?.id;
        if (lastTurnId && typeof (this.sdkClient.sessions as any).createTurnEvents === 'function') {
          return await (this.sdkClient.sessions as any).createTurnEvents(sessionId, lastTurnId, {
            events: [approvalPayload],
          });
        }
      } catch {
        // Silent fallback — editor already applied/discarded proposal safely
      }
      console.warn(`Approval resume acknowledged locally: ${err.message}`);
      return null;
    }
  }
}
