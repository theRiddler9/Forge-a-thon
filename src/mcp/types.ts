import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpServerOptions {
  port?: number;
  host?: string;
  name?: string;
  version?: string;
  workspaceRoot?: string;
  /**
   * When set, the SSE handshake (GET /sse) requires `?token=<authToken>`.
   * The /messages endpoint stays gated by the unguessable per-connection
   * sessionId issued over the authenticated stream.
   */
  authToken?: string;
}

export interface McpServerInstance {
  port: number;
  host: string;
  url: string;
  mcpServer: McpServer;
  close: () => Promise<void>;
}
