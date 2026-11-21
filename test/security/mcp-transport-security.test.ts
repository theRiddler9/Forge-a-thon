import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { startMcpServer, McpServerInstance } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/**
 * Security tests for the MCP HTTP transport itself.
 *
 * The production extension always starts the server with a per-activation
 * `authToken`: the SSE handshake requires `?token=`, and /messages stays
 * gated by the unguessable per-connection sessionId. These tests cover both
 * modes — open (no token, used by tests/dev) and authenticated.
 */
describe('MCP transport security — open mode (no authToken)', () => {
  const ws = path.resolve(__dirname, '../fixtures/mcp_auth');
  let instance: McpServerInstance | undefined;

  beforeEach(async () => {
    fs.mkdirSync(ws, { recursive: true });
    instance = await startMcpServer({ workspaceRoot: ws, port: 0 });
  });

  afterEach(async () => {
    await instance?.close().catch(() => {});
    instance = undefined;
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('documents: without authToken any local client can call run_command', async () => {
    // Open mode exists for tests/dev only; production (extension.ts) always
    // passes authToken. This test pins the behaviour so a regression that
    // silently drops auth in production would be caught by the auth suite.
    const client = new Client({ name: 'attacker', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(instance!.url)));

    const pwned = path.join(ws, 'pwned.txt');
    const res = await client.callTool({
      name: 'run_command',
      arguments: {
        command: `node -e "require('fs').writeFileSync('${pwned.replace(/\\/g, '/')}', 'owned')"`,
        timeoutMs: 10000,
      },
    });
    expect(res.isError).not.toBe(true);
    expect(fs.existsSync(pwned)).toBe(true);
    await client.close();
  });

  it('does not advertise wildcard CORS to browsers', async () => {
    const res = await fetch(`${instance!.url}`, { method: 'OPTIONS' });
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('*');
  });
});

describe('MCP transport security — authenticated mode', () => {
  const ws = path.resolve(__dirname, '../fixtures/mcp_auth_token');
  const TOKEN = 'test-token-abc123';
  let instance: McpServerInstance | undefined;

  beforeEach(async () => {
    fs.mkdirSync(ws, { recursive: true });
    instance = await startMcpServer({ workspaceRoot: ws, port: 0, authToken: TOKEN });
  });

  afterEach(async () => {
    await instance?.close().catch(() => {});
    instance = undefined;
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('rejects the SSE handshake without a token', async () => {
    const res = await fetch(`http://${instance!.host}:${instance!.port}/sse`);
    expect(res.status).toBe(401);
  });

  it('rejects the SSE handshake with a wrong token', async () => {
    const res = await fetch(`http://${instance!.host}:${instance!.port}/sse?token=wrong`);
    expect(res.status).toBe(401);
  });

  it('accepts the handshake with the correct token and serves tools', async () => {
    const client = new Client({ name: 'trueforge', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(instance!.url)));
    const res = await client.callTool({ name: 'list_dir', arguments: {} });
    expect(res.isError).not.toBe(true);
    await client.close();
  });

  it('returned url embeds the token so TrueForge can connect', () => {
    expect(instance!.url).toContain(`/sse?token=${encodeURIComponent(TOKEN)}`);
  });

  it('rejects /messages POSTs with an unknown sessionId', async () => {
    const res = await fetch(
      `http://${instance!.host}:${instance!.port}/messages?sessionId=forged-session`,
      { method: 'POST', body: '{}' }
    );
    expect(res.status).toBe(404);
  });
});
