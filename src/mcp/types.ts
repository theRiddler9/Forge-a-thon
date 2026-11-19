import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface McpServerOptions {
  port?: number;
  host?: string;
  name?: string;
  version?: string;
}

export interface McpServerInstance {
  port: number;
  host: string;
  url: string;
  mcpServer: McpServer;
  close: () => Promise<void>;
}
