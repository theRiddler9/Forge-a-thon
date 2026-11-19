import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { startMcpServer, McpServerInstance } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/**
 * Security tests for the MCP HTTP transport itself.
 *
 * CONFIRMED ARCHITECTURAL RISK: the server binds 127.0.0.1 with no auth and
 * sets Access-Control-Allow-Origin: *, and run_command executes shell commands
 * with NO in-tool approval check (approval is purely a TrueForge-side concept).
 * Any local process — or any web page the developer visits, via CORS — can
 * connect and invoke run_command directly, bypassing the entire diff-review
 * approval flow that B2/B4 depend on.
 */
describe('MCP transport security', () => {
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

  it('demonstrates: any unauthenticated client can call run_command (approval bypass)', async () => {
    // This test DOCUMENTS the current exposure: no token, no origin check.
    // If a future fix adds auth, flip this to a normal `it` asserting rejection.
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
    // The command ran with zero approval — file was created by an
    // unauthenticated client that never went through TrueForge.
    expect(fs.existsSync(pwned)).toBe(true);
    await client.close();
  });

  it.fails('server does not advertise wildcard CORS to browsers', async () => {
    // KNOWN ISSUE: Access-Control-Allow-Origin: * lets any website the
    // developer visits POST to this localhost server (CSRF-style attack
    // surface for run_command). Safe behaviour: no ACAO header or a
    // specific allowlist.
    const res = await fetch(`${instance!.url}`, { method: 'OPTIONS' });
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao === '*' || acao === null).toBe(true);
    expect(acao).not.toBe('*');
  });

  it.fails('server rejects MCP sessions without a registered credential', async () => {
    // KNOWN ISSUE: SSE endpoint accepts any client. Safe behaviour would be
    // a per-session token injected by the extension at registration time.
    const res = await fetch(`http://${instance!.host}:${instance!.port}/sse`);
    // Currently returns 200 + event stream; a fixed server would 401/403.
    expect([401, 403]).toContain(res.status);
  });
});
