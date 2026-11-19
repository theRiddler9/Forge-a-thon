import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { executeRunCommand, MAX_CMD_OUTPUT_LENGTH } from '../../src/mcp/tools/runCommand.js';

/**
 * run_command executes arbitrary shell commands. It is approval-gated on the
 * TrueForge side, so these tests pin down its local contract: cwd confinement,
 * timeout enforcement, output truncation, and exit-code reporting.
 */
describe('run_command tool', () => {
  const ws = path.resolve(__dirname, '../fixtures/run_cmd');

  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('runs a command with workspaceRoot as cwd', async () => {
    const res = await executeRunCommand(ws, {
      command: 'node -e "console.log(process.cwd())"',
      timeoutMs: 10000,
    });
    const text = res.content[0].text;
    // cwd should be the workspace root (modulo path separator/case on Windows)
    expect(text.replace(/\\/g, '/').toLowerCase()).toContain(
      ws.replace(/\\/g, '/').toLowerCase()
    );
  });

  it('captures stdout', async () => {
    const res = await executeRunCommand(ws, { command: 'node -e "console.log(42)"', timeoutMs: 10000 });
    expect(res.content[0].text).toContain('42');
  });

  it('captures stderr separately', async () => {
    const res = await executeRunCommand(ws, {
      command: 'node -e "console.error(\'oops\')"',
      timeoutMs: 10000,
    });
    expect(res.content[0].text).toContain('STDERR');
    expect(res.content[0].text).toContain('oops');
  });

  it('reports non-zero exit codes instead of throwing', async () => {
    const res = await executeRunCommand(ws, {
      command: 'node -e "process.exit(3)"',
      timeoutMs: 10000,
    });
    const text = res.content[0].text;
    expect(text).toContain('3');
  });

  it('kills long-running commands at the timeout', async () => {
    const start = Date.now();
    const res = await executeRunCommand(ws, {
      command: 'node -e "setTimeout(()=>{},60000)"',
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000); // did not wait 60s
    expect(res.content[0].text).toBeDefined();
  });

  it('truncates output beyond MAX_CMD_OUTPUT_LENGTH', async () => {
    // ~20k chars of output
    const res = await executeRunCommand(ws, {
      command: 'node -e "console.log(\'x\'.repeat(20000))"',
      timeoutMs: 15000,
    });
    const text = res.content[0].text;
    expect(text).toContain('Truncated');
    expect(text.length).toBeLessThanOrEqual(MAX_CMD_OUTPUT_LENGTH + 200);
  });

  it('returns a friendly message for empty output', async () => {
    const res = await executeRunCommand(ws, {
      command: 'node -e ""',
      timeoutMs: 10000,
    });
    expect(res.content[0].text).toContain('no output');
  });

  it('handles nonexistent command without throwing', async () => {
    const res = await executeRunCommand(ws, {
      command: 'definitely-not-a-real-command-xyz',
      timeoutMs: 10000,
    });
    const text = res.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  });

  it('timeoutMs of 0 does not hang the tool indefinitely on fast commands', async () => {
    // Documents Node exec semantics: timeout:0 may mean "no timeout".
    // Fast commands still return; the risk is only for hung processes.
    const res = await executeRunCommand(ws, {
      command: 'node -e "console.log(\'fast\')"',
      timeoutMs: 0,
    });
    expect(res.content[0].text).toContain('fast');
  });
});
