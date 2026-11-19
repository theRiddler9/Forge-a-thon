import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { parseMentions, resolveMentions, formatContextBlock } from '../../src/context/mentions.js';

describe('Context Assembly: @mentions & Strategy', () => {
  const testWorkspace = path.resolve(__dirname, '../fixtures/context_test');

  beforeEach(() => {
    fs.mkdirSync(testWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(testWorkspace, 'helpers.py'),
      [
        '# Helper module',
        'def get_debug_flag():',
        '    """Get debug flag value."""',
        '    return False',
      ].join('\n')
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it('parses @file and @symbol mentions from prompt text', () => {
    const input = 'Check @file:helpers.py and inspect @symbol:get_debug_flag for details.';
    const parsed = parseMentions(input);

    expect(parsed.fileMentions).toContain('helpers.py');
    expect(parsed.symbolMentions).toContain('get_debug_flag');
  });

  it('resolves @file mentions to line ranges and content', async () => {
    const resolved = await resolveMentions(testWorkspace, {
      fileMentions: ['helpers.py'],
      symbolMentions: [],
    });

    expect(resolved.length).toBe(1);
    expect(resolved[0].type).toBe('file');
    expect(resolved[0].target).toBe('helpers.py');
    expect(resolved[0].content).toContain('def get_debug_flag():');
    expect(resolved[0].tokens).toBeGreaterThan(0);
  });

  it('resolves @symbol mentions to symbol location and snippets', async () => {
    const resolved = await resolveMentions(testWorkspace, {
      fileMentions: [],
      symbolMentions: ['get_debug_flag'],
    });

    expect(resolved.length).toBe(1);
    expect(resolved[0].type).toBe('symbol');
    expect(resolved[0].target).toBe('get_debug_flag');
    expect(resolved[0].content).toContain('def get_debug_flag():');
  });

  it('formats context block with explicit budget and chosen rationale', () => {
    const block = formatContextBlock([
      {
        type: 'file',
        target: 'helpers.py',
        content: 'def get_debug_flag():\n    return False',
        lines: '1-4',
        tokens: 30,
        reason: 'User mentioned @file:helpers.py',
      },
    ]);

    expect(block).toContain('Context Chosen');
    expect(block).toContain('helpers.py');
    expect(block).toContain('User mentioned @file:helpers.py');
  });
});
