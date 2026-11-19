export interface TrueForgeModelInfo {
  name: string;
  contextLength?: number;
  maxOutputTokens?: number;
}

export interface TrueForgeClientConfig {
  baseUrl: string;
  primaryModel: string;
  fallbackModel?: string;
  mcpServerName?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface TurnMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TurnStreamCallbacks {
  onEvent?: (event: any, sequenceId: number | string) => void;
  onDelta?: (text: string, eventId: string) => void;
  onReasoningDelta?: (text: string, eventId: string) => void;
  onToolApprovalRequired?: (toolCallId: string, toolName: string, args: any) => void;
  onError?: (err: Error) => void;
  onDone?: (status: string, message?: string, metrics?: TurnMetrics) => void;
}
