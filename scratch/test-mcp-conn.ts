import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const activeTransports = new Map<string, SSEServerTransport>();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:9999');
  if (req.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    activeTransports.set(transport.sessionId, transport);
    const mcp = new McpServer({ name: 'test', version: '1.0.0' });
    mcp.tool('ping', 'ping tool', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
    await mcp.connect(transport);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/messages') {
    const sid = url.searchParams.get('sessionId');
    const t = activeTransports.get(sid ?? '');
    if (t) {
      await t.handlePostMessage(req, res);
      return;
    }
  }
  res.writeHead(404);
  res.end();
});

server.listen(9999, '127.0.0.1', async () => {
  console.log('Server started');
  try {
    // Client 1
    const client1 = new Client({ name: 'c1', version: '1' }, { capabilities: {} });
    await client1.connect(new SSEClientTransport(new URL('http://127.0.0.1:9999/sse')));
    const tools1 = await client1.listTools();
    console.log('Client 1 tools:', tools1.tools.map((t) => t.name));

    // Client 2 (second concurrent connection!)
    const client2 = new Client({ name: 'c2', version: '1' }, { capabilities: {} });
    await client2.connect(new SSEClientTransport(new URL('http://127.0.0.1:9999/sse')));
    const tools2 = await client2.listTools();
    console.log('Client 2 tools:', tools2.tools.map((t) => t.name));

    await client1.close();
    await client2.close();
    console.log('ALL PASSED!');
  } catch (err: any) {
    console.error('Test error:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
