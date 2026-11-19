import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { TrueForgeClientConfig, TurnStreamCallbacks } from './types.js';

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

  async listAvailableModels(): Promise<string[]> {
    try {
      const res = await this.sdkClient.models.list();
      const list = (res.data?.map((m: any) => m.name || m.id) || []).filter(Boolean);
      if (list.length > 0 && (!this.activeModel || !list.includes(this.activeModel))) {
        this.activeModel = list[0];
      }
      return list;
    } catch (err: any) {
      console.warn(`Could not fetch models from TrueForge: ${err.message}`);
      return [];
    }
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
              preloadTools: ['list_dir', 'read_file', 'search_text', 'find_symbol', 'get_context_budget_info'],
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
          const existing = eventsMap.get(event.id);
          const merged = existing ? mergeEventDelta(existing, event) : event;
          eventsMap.set(event.id, merged);

          if (callbacks.onDelta) {
            const textDelta = (event as any).delta?.content?.[0]?.text ?? (event as any).delta?.text ?? '';
            if (textDelta) {
              callbacks.onDelta(textDelta, event.id);
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
          const toolCallId = (event as any).toolCallId;
          const sourceEvent = eventsMap.get((event as any).sourceEventId);
          const toolCall = sourceEvent?.toolCalls?.find((tc: any) => tc.id === toolCallId);
          if (callbacks.onToolApprovalRequired) {
            callbacks.onToolApprovalRequired(toolCallId, toolCall?.name ?? 'unknown', toolCall?.arguments ?? {});
          }
        }

        // Check for turn completion
        if ((event as any).type === 'turn.done') {
          const status = (event as any).state?.status ?? 'done';
          if (callbacks.onDone) {
            callbacks.onDone(status);
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
      // Resume by initiating next turn with tool approval event
      return await this.sdkClient.sessions.createTurn(sessionId, {
        input: [approvalPayload],
      });
    } catch (err: any) {
      console.warn(`Failed to resume approval: ${err.message}`);
      throw err;
    }
  }
}
