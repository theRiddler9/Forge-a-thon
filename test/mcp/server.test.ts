import { describe, it, expect, afterEach } from 'vitest';
import { startMcpServer, McpServerInstance } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

describe('In-Process MCP Server', () => {
  let instance: McpServerInstance | undefined;

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = undefined;
    }
  });

  it('starts on an available localhost port and handles MCP client handshake', async () => {
    instance = await startMcpServer({ port: 0 });
    expect(instance.port).toBeGreaterThan(0);
    expect(instance.url).toBe(`http://127.0.0.1:${instance.port}/sse`);

    // Connect an MCP client to verify end-to-end transport
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new SSEClientTransport(new URL(instance.url));
    await client.connect(transport);

    const toolsResult = await client.listTools();
    expect(toolsResult.tools).toBeDefined();
    expect(Array.isArray(toolsResult.tools)).toBe(true);

    await client.close();
  });
});
