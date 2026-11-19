import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { executeListDir } from '../../src/mcp/tools/listDir.js';
import { executeReadFile } from '../../src/mcp/tools/readFile.js';
import { executeSearchText } from '../../src/mcp/tools/searchText.js';
import { executeFindSymbol } from '../../src/mcp/tools/findSymbol.js';
import { ContextBudgetTracker } from '../../src/mcp/tools/contextBudget.js';

describe('Read & Context MCP Tools', () => {
  const testWorkspace = path.resolve(__dirname, '../fixtures/workspace');

  beforeEach(() => {
    fs.mkdirSync(path.join(testWorkspace, 'subdir'), { recursive: true });
    fs.writeFileSync(
      path.join(testWorkspace, 'sample.py'),
      [
        '# Sample Python file',
        'def get_debug_flag():',
        '    """Returns True if debug flag is on."""',
        '    return False',
        '',
        'class ConfigLoader:',
        '    def load(self):',
        '        pass',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(testWorkspace, 'subdir/other.txt'),
      'Hello from subdir other file\nsecond line with query term\n'
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it('lists directory contents with relative paths', async () => {
    const result = await executeListDir(testWorkspace, { relativePath: '.' });
    expect(result.content).toBeDefined();
    const text = result.content[0].text;
    expect(text).toContain('sample.py');
    expect(text).toContain('subdir/');
  });

  it('reads specific line ranges and enforces max line limit', async () => {
    const result = await executeReadFile(testWorkspace, {
      path: 'sample.py',
      startLine: 2,
      endLine: 4,
    });
    const text = result.content[0].text;
    expect(text).toContain('def get_debug_flag():');
    expect(text).toContain('return False');
    expect(text).not.toContain('class ConfigLoader:');
  });

  it('searches text across files with match line numbers and snippets', async () => {
    const result = await executeSearchText(testWorkspace, {
      query: 'query term',
    });
    const text = result.content[0].text;
    expect(text).toContain('other.txt');
    expect(text).toContain('query term');
  });

  it('finds symbols like functions and classes', async () => {
    const result = await executeFindSymbol(testWorkspace, {
      name: 'get_debug_flag',
    });
    const text = result.content[0].text;
    expect(text).toContain('get_debug_flag');
    expect(text).toContain('sample.py');
  });

  it('tracks context budget consumption and remaining tokens', () => {
    const tracker = new ContextBudgetTracker(1000);
    expect(tracker.getBudgetInfo().remainingTokens).toBe(1000);

    tracker.recordTokens('sample.py', 300);
    const info = tracker.getBudgetInfo();
    expect(info.usedTokens).toBe(300);
    expect(info.remainingTokens).toBe(700);
    expect(info.items[0].path).toBe('sample.py');
  });
});
