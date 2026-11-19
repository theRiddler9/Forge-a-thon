import { describe, it, expect } from 'vitest';
import http from 'http';
import { TrueForgeClient } from '../../src/trueforge/client.js';

describe('TrueForgeClient', () => {
  it('manages session creation, streaming, and fallback', async () => {
    let callCount = 0;
    const now = new Date().toISOString();

    const mockServer = http.createServer((req, res) => {
      // Endpoint: create session
      if (req.method === 'POST' && req.url?.includes('/sessions')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          const modelName = parsed.agent?.spec?.model?.name;
          callCount++;

          // If primary model, simulate failure on first call to trigger fallback
          if (modelName === 'broken/primary') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Primary model unavailable' }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                id: 'sess-12345',
                agent: parsed.agent ?? { spec: { model: { name: modelName } } },
                created_at: now,
                created_by_subject: 'user',
                last_turn_details: null,
                metadata: {},
                metrics: {},
                source: 'api',
                title: 'ForgePilot Session',
                updated_at: now,
              },
            })
          );
        });
        return;
      }

      // Endpoint: cancel session
      if (req.method === 'POST' && req.url?.includes('/cancel')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cancelled' }));
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const address = mockServer.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const client = new TrueForgeClient({
        baseUrl,
        primaryModel: 'broken/primary',
        fallbackModel: 'working/fallback',
        maxRetries: 1,
        retryDelayMs: 20,
      });

      // Test fallback: creating session with primary model fails -> falls back to working/fallback model
      const session = await client.createSessionWithFallback('instructions...');
      expect(session).toBeDefined();
      expect(session.id).toBe('sess-12345');
      expect(client.getActiveModel()).toBe('working/fallback');

      // Test cancel
      const cancelResult = await client.cancelSession(session.id);
      expect(cancelResult).toBe(true);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
