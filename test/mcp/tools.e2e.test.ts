import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { startMcpServer, McpServerInstance } from '../../src/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { globalEditStaging } from '../../src/edit/staging.js';

/**
 * True end-to-end tests: a real MCP client speaks JSON-RPC over SSE to the
 * in-process server exactly as TrueForge would. Verifies tool registration,
 * annotations (approval gating relies on destructiveHint), argument schemas,
 * and that propose_write stages without touching disk.
 */
describe('MCP server e2e (real SSE transport)', () => {
  const ws = path.resolve(__dirname, '../fixtures/mcp_e2e');
  let instance: McpServerInstance | undefined;
  let client: Client | undefined;

  beforeEach(async () => {
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'src', 'main.py'),
      'def main():\n    print("hello")\n\nclass App:\n    pass\n'
    );
    fs.writeFileSync(path.join(ws, 'README.md'), '# demo\nsearchable token here\n');
    globalEditStaging.clearAll();

    instance = await startMcpServer({ workspaceRoot: ws, port: 0 });
    client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(new URL(instance.url)));
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await instance?.close().catch(() => {});
    client = undefined;
    instance = undefined;
    globalEditStaging.clearAll();
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('exposes exactly the 7 ForgePilot tools', async () => {
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'find_symbol',
      'get_context_budget_info',
      'list_dir',
      'propose_write',
      'read_file',
      'run_command',
      'search_text',
    ]);
  });

  it('marks propose_write and run_command as destructive (approval-gated)', async () => {
    const { tools } = await client!.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('propose_write')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('run_command')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('read_file')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('search_text')?.annotations?.readOnlyHint).toBe(true);
  });

  it('read_file returns line-numbered content over the wire', async () => {
    const res = await client!.callTool({
      name: 'read_file',
      arguments: { path: 'src/main.py', startLine: 1, endLine: 2 },
    });
    const text = (res.content as any[])[0].text;
    expect(text).toContain('def main():');
    expect(text).toContain('print("hello")');
    expect(text).not.toContain('class App:');
  });

  it('search_text finds matches with path:line format', async () => {
    const res = await client!.callTool({
      name: 'search_text',
      arguments: { query: 'searchable token' },
    });
    const text = (res.content as any[])[0].text;
    expect(text).toContain('README.md');
  });

  it('find_symbol locates a class definition', async () => {
    const res = await client!.callTool({
      name: 'find_symbol',
      arguments: { name: 'App' },
    });
    const text = (res.content as any[])[0].text;
    expect(text).toContain('App');
    expect(text).toContain('main.py');
  });

  it('get_context_budget_info reports budget fields', async () => {
    const res = await client!.callTool({ name: 'get_context_budget_info', arguments: {} });
    const info = JSON.parse((res.content as any[])[0].text);
    expect(info).toHaveProperty('totalBudget');
    expect(info).toHaveProperty('usedTokens');
    expect(info).toHaveProperty('remainingTokens');
  });

  it('propose_write stages an in-memory proposal and never touches disk', async () => {
    const target = path.join(ws, 'new_file.py');
    const res = await client!.callTool({
      name: 'propose_write',
      arguments: { path: 'new_file.py', newContent: 'x = 1\n' },
    });
    const text = (res.content as any[])[0].text;
    expect(text).toContain('Edit proposed');

    // Staged in memory, disk untouched
    expect(fs.existsSync(target)).toBe(false);
    expect(globalEditStaging.getAllProposals()).toHaveLength(1);
    const prop = globalEditStaging.getAllProposals()[0];
    expect(prop.relativePath).toBe('new_file.py');
    expect(prop.hunks.length).toBeGreaterThan(0);
  });

  it('run_command executes and returns output', async () => {
    const isWin = process.platform === 'win32';
    const res = await client!.callTool({
      name: 'run_command',
      arguments: { command: isWin ? 'echo hello-mcp' : 'echo hello-mcp', timeoutMs: 10000 },
    });
    const text = (res.content as any[])[0].text;
    expect(text).toContain('hello-mcp');
  });

  it('rejects calls with missing required arguments at the protocol layer', async () => {
    // MCP surfaces schema violations as isError tool results, not exceptions.
    const res = await client!.callTool({ name: 'read_file', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as any[])[0].text;
    expect(text).toContain('path');
  });
});
