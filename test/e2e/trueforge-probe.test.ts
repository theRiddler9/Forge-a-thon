import { describe, it, expect, vi } from 'vitest';
import { probeTrueForge } from '../../scripts/probe-trueforge.js';
import http from 'http';

describe('TrueForge Probe Harness', () => {
  it('detects when TrueForge server is unreachable on an unused port', async () => {
    const result = await probeTrueForge('http://localhost:59999');
    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('detects when TrueForge server responds with models', async () => {
    // Spin up an in-process mock server emulating TrueForge models endpoint
    const mockServer = http.createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'anthropic/claude-sonnet-4-6', name: 'anthropic/claude-sonnet-4-6' },
            { id: 'openai/gpt-4o', name: 'openai/gpt-4o' }
          ]
        }));
        return;
      }
      if (req.url?.includes('/settings/mcp-servers')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const address = mockServer.address() as any;
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const result = await probeTrueForge(url);
      expect(result.reachable).toBe(true);
      expect(result.modelsCount).toBe(2);
      expect(result.models).toContain('anthropic/claude-sonnet-4-6');
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
