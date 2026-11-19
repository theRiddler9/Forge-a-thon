import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { TrueForgeClient } from '../../src/trueforge/client.js';
import { TurnStreamCallbacks } from '../../src/trueforge/types.js';

/**
 * E2E tests for TrueForgeClient against a mock TrueForge server speaking the
 * real wire protocol. Verified facts baked into the mock:
 *  - POST /api/v1/sessions creates a session; agent.spec serializes to
 *    snake_case (mcp_servers, require_approval_for_tools, preload_tools).
 *  - POST /api/v1/sessions/{id}/turns with {stream:true} returns an SSE
 *    stream of TurnStreamingEvents whose fields are snake_case on the wire
 *    (created_at, thread_id, tool_calls, source_event_id, ...).
 *  - ToolApprovalRequiredEvent carries toolCalls:[{id, source_event_id}];
 *    there is NO top-level toolCallId on the event.
 *  - ModelMessageEvent.toolCalls[] entries are {id, type:'function',
 *    function:{name, arguments}} — name/args are NESTED under `function`.
 *  - Approval resume is POST /sessions/{id}/turns/{turnId}/events via
 *    sessions.createTurnEvents — NOT a user.tool_approval turn input.
 */

const now = () => new Date().toISOString();
const sse = (seq: number, payload: any) => `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;

interface MockHandle {
  url: string;
  close: () => Promise<void>;
  turnBodies: any[];
  sessionBodies: any[];
  rawBodies: string[];
}

async function startMockTrueForge(handlers: {
  onTurnStream?: (res: http.ServerResponse) => void;
}): Promise<MockHandle> {
  const turnBodies: any[] = [];
  const sessionBodies: any[] = [];
  const rawBodies: string[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      rawBodies.push(`${req.method} ${req.url} :: ${body.slice(0, 4000)}`);
      let parsed: any = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {}

      if (req.method === 'POST' && /\/api\/v1\/sessions$/.test(req.url ?? '')) {
        sessionBodies.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              id: 'sess-e2e',
              created_at: now(),
              updated_at: now(),
              agent: { type: 'inline', spec: parsed.agent?.spec },
              source: 'api',
              title: 'mock',
              metadata: {},
              metrics: {},
            },
          })
        );
        return;
      }

      // Turn events endpoint (approval resume path)
      if (req.method === 'POST' && /\/turns\/[^/]+\/events/.test(req.url ?? '')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { accepted: true } }));
        return;
      }

      const turnMatch = req.url?.match(/\/api\/v1\/sessions\/([^/]+)\/turns/);
      if (req.method === 'POST' && turnMatch) {
        turnBodies.push(parsed);
        if (parsed.stream === false || handlers.onTurnStream == null) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'turn-1', state: { status: 'done' } } }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        handlers.onTurnStream!(res);
        return;
      }

      if (req.method === 'POST' && /\/cancel/.test(req.url ?? '')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cancelled' }));
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as any;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    turnBodies,
    sessionBodies,
    rawBodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const turnCreated = () => ({
  id: 'e1',
  created_at: now(),
  type: 'turn.created',
  turn_id: 'turn-1',
  thread_id: null,
  previous_turn_id: null,
  state: { status: 'running' },
});

const turnDone = (requiredActions: any[] = [], status = 'done') => ({
  id: 'e9',
  created_at: now(),
  type: 'turn.done',
  thread_id: null,
  state: {
    status,
    completed_at: now(),
    output: null,
    required_actions: requiredActions,
  },
});

function writeEvents(res: http.ServerResponse, events: any[]) {
  events.forEach((e, i) => res.write(sse(i + 1, e)));
  res.end();
}

describe('TrueForgeClient stream e2e (mock SSE server)', () => {
  let mock: MockHandle | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  function makeClient() {
    return new TrueForgeClient({
      baseUrl: mock!.url,
      primaryModel: 'test/primary',
      fallbackModel: 'test/fallback',
      maxRetries: 1,
      retryDelayMs: 10,
    });
  }

  it('streams deltas and resolves turn.done status', async () => {
    const deltas: string[] = [];
    let doneStatus: string | undefined;

    mock = await startMockTrueForge({
      onTurnStream: (res) =>
        writeEvents(res, [
          turnCreated(),
          { id: 'e2', created_at: now(), type: 'model.message', thread_id: 'main', content: 'Hello ' },
          { id: 'e2', created_at: now(), type: 'model.message.delta', thread_id: 'main', content: 'world' },
          turnDone(),
        ]),
    });

    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');
    await client.streamTurn(session.id, 'hi', {
      onDelta: (t) => deltas.push(t),
      onDone: (s) => (doneStatus = s),
    });

    expect(deltas).toContain('world');
    expect(doneStatus).toBe('done');
  });

  it('surfaces tool.approval_required with toolCallId, name and args', async () => {
    // KNOWN BUGS this exposes in client.ts streamTurn:
    //  1. reads event.toolCallId / event.sourceEventId, but the real
    //     ToolApprovalRequiredEvent carries tool_calls:[{id, source_event_id}]
    //  2. reads tc.name / tc.arguments, but ToolCall nests them under
    //     function.{name,arguments}
    //  3. mergeEventDelta returns void; storing its return in eventsMap
    //     corrupts the entry used for tool-call lookup
    const approvals: Array<{ id?: string; name: string; args: any }> = [];

    mock = await startMockTrueForge({
      onTurnStream: (res) =>
        writeEvents(res, [
          turnCreated(),
          {
            id: 'e2',
            created_at: now(),
            type: 'model.message',
            thread_id: 'main',
            content: 'editing',
            tool_calls: [
              {
                id: 'tc-1',
                index: 0,
                type: 'function',
                function: {
                  name: 'propose_write',
                  arguments: JSON.stringify({ path: 'a.py', new_content: 'x=1\n' }),
                },
                tool_info: { type: 'mcp', name: 'propose_write', server_id: 'srv1', server_name: 'forgepilot' },
              },
            ],
          },
          {
            id: 'e3',
            created_at: now(),
            type: 'tool.approval_required',
            thread_id: 'main',
            tool_calls: [{ id: 'tc-1', source_event_id: 'e2' }],
          },
          turnDone(),
        ]),
    });

    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');
    await client.streamTurn(session.id, 'edit', {
      onToolApprovalRequired: (id, name, args) => approvals.push({ id, name, args }),
    });

    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe('tc-1');
    expect(approvals[0].name).toBe('propose_write');
    expect(approvals[0].args).toMatchObject({ path: 'a.py' });
  });

  it('approval lookup survives interleaved model.message.delta events', async () => {
    const approvals: Array<{ id?: string; name: string }> = [];

    mock = await startMockTrueForge({
      onTurnStream: (res) =>
        writeEvents(res, [
          turnCreated(),
          {
            id: 'e2',
            created_at: now(),
            type: 'model.message',
            thread_id: 'main',
            content: 'start',
            tool_calls: [
              {
                id: 'tc-9',
                index: 0,
                type: 'function',
                function: { name: 'propose_write', arguments: '{}' },
                tool_info: { type: 'mcp', name: 'propose_write', server_id: 'srv1', server_name: 'forgepilot' },
              },
            ],
          },
          // delta shares the base message id and arrives after it
          { id: 'e2', created_at: now(), type: 'model.message.delta', thread_id: 'main', content: '+more' },
          {
            id: 'e3',
            created_at: now(),
            type: 'tool.approval_required',
            thread_id: 'main',
            tool_calls: [{ id: 'tc-9', source_event_id: 'e2' }],
          },
          turnDone(),
        ]),
    });

    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');
    await client.streamTurn(session.id, 'edit', {
      onToolApprovalRequired: (id, name) => approvals.push({ id, name }),
    });

    expect(approvals[0]?.name).toBe('propose_write');
  });

  it('runTurn resolves error status when the turn ends with error', async () => {
    mock = await startMockTrueForge({
      onTurnStream: (res) =>
        writeEvents(res, [
          turnCreated(),
          {
            id: 'e2',
            created_at: now(),
            type: 'turn.done',
            thread_id: null,
            state: {
              status: 'error',
              completed_at: now(),
              output: null,
              required_actions: [],
              message: 'model exploded',
            },
          },
        ]),
    });

    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');
    const outcome = await client.runTurn(session.id, 'hi');
    expect(outcome.status).toBe('error');
  });

  it.fails('runTurn resolves when the SSE stream ends without turn.done', async () => {
    // KNOWN BUG: clean EOF without a terminal turn.done leaves runTurn's
    // promise pending forever — the panel await hangs.
    mock = await startMockTrueForge({
      onTurnStream: (res) => {
        res.write(sse(1, turnCreated()));
        res.end();
      },
    });

    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');
    const outcome = await Promise.race([
      client.runTurn(session.id, 'hi'),
      new Promise<{ status: string }>((r) => setTimeout(() => r({ status: 'TIMEOUT-PENDING' }), 1500)),
    ]);
    expect(outcome.status).not.toBe('TIMEOUT-PENDING');
  });

  it.fails('resumeApproval uses createTurnEvents, not an invalid turn input', async () => {
    // KNOWN BUG: resumeApproval posts {type:'user.tool_approval'} inside a
    // createTurn `input`, which the SDK serializer rejects client-side
    // (input only accepts user.message). Correct API: sessions.createTurnEvents
    // with events:[UserToolApprovalInputEvent].
    mock = await startMockTrueForge({ onTurnStream: (res) => res.end() });
    const client = makeClient();
    const session = await client.createSession('test/primary', 'instr');

    await client.resumeApproval(session.id, 'tc-1', 'allow');

    const eventsCall = mock!.rawBodies.find((b) => b.includes('/events'));
    expect(eventsCall).toBeDefined();
    expect(eventsCall).toContain('user.tool_approval');
    expect(eventsCall).toContain('tc-1');
  });

  it('session spec on the wire gates propose_write and run_command for approval', async () => {
    mock = await startMockTrueForge({ onTurnStream: (res) => res.end() });
    const client = makeClient();
    await client.createSession('test/primary', 'instr');

    const raw = mock!.rawBodies.find((b) => b.includes('sessions')) ?? '';
    const body = JSON.parse(raw.split('::')[1] ?? '{}');
    const mcp = body?.agent?.spec?.mcp_servers?.[0];
    expect(mcp, raw).toBeDefined();
    expect(mcp.require_approval_for_tools).toEqual(
      expect.arrayContaining(['propose_write', 'run_command'])
    );
    expect(mcp.preload_tools).toEqual(expect.arrayContaining(['read_file', 'search_text']));
  });
});
