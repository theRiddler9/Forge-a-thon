import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpServerOptions, McpServerInstance } from './types.js';
import { registerReadAndContextTools } from './tools/index.js';

export type { McpServerInstance, McpServerOptions };

export function createConfiguredMcpServer(name: string, version: string, workspaceRoot: string): McpServer {
  const mcpServer = new McpServer({ name, version });
  registerReadAndContextTools(mcpServer, workspaceRoot);
  return mcpServer;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<McpServerInstance> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const name = options.name ?? 'forgepilot';
  const version = options.version ?? '0.1.0';
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const authToken = options.authToken;

  const baselineServer = createConfiguredMcpServer(name, version, workspaceRoot);
  const activeTransports = new Map<string, SSEServerTransport>();
  const activeServers = new Map<string, McpServer>();

  const httpServer = http.createServer(async (req, res) => {
    // No wildcard CORS: this server can execute commands, so browser origins
    // must never be able to reach it. MCP clients are not browsers.
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const hostHeader = req.headers.host || `${host}:${port}`;
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);

    const matchesPath = url.pathname === '/sse' || (authToken && url.pathname === `/${authToken}/sse`);
    if (req.method === 'GET' && matchesPath) {
      const headerAuth = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const queryToken = url.searchParams.get('token');
      const pathToken = authToken && url.pathname === `/${authToken}/sse` ? authToken : undefined;
      const providedToken = queryToken || headerAuth || pathToken;

      if (authToken && providedToken !== authToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing token' }));
        return;
      }
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      activeTransports.set(sessionId, transport);

      const connMcpServer = createConfiguredMcpServer(name, version, workspaceRoot);
      activeServers.set(sessionId, connMcpServer);

      transport.onclose = () => {
        activeTransports.delete(sessionId);
        const s = activeServers.get(sessionId);
        activeServers.delete(sessionId);
        s?.close().catch(() => {});
      };

      await connMcpServer.connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !activeTransports.has(sessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const transport = activeTransports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.on('error', reject);
  });

  const address = httpServer.address() as any;
  const actualPort = address.port;
  // NOTE: The token is passed as a query param (?token=...). TrueForge must
  // preserve query params when registering and later calling the MCP server URL.
  // We also accept Authorization: Bearer <token> and path segment /<token>/sse
  // as fallbacks if TrueForge or an intermediary proxy strips query parameters.
  const actualUrl = authToken
    ? `http://${host}:${actualPort}/sse?token=${encodeURIComponent(authToken)}`
    : `http://${host}:${actualPort}/sse`;

  return {
    port: actualPort,
    host,
    url: actualUrl,
    mcpServer: baselineServer,
    close: async () => {
      for (const transport of activeTransports.values()) {
        try {
          await transport.close();
        } catch {}
      }
      activeTransports.clear();
      for (const s of activeServers.values()) {
        try {
          await s.close();
        } catch {}
      }
      activeServers.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
