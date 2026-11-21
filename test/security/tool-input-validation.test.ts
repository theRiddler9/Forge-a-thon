import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { executeReadFile } from '../../src/mcp/tools/readFile.js';
import { executeFindSymbol } from '../../src/mcp/tools/findSymbol.js';
import { executeSearchText } from '../../src/mcp/tools/searchText.js';
import { executeListDir } from '../../src/mcp/tools/listDir.js';

/**
 * Input-validation tests: MCP tool arguments come from an LLM and can be
 * malformed, adversarial, or extreme. Tools must fail safely (error text,
 * clamped ranges, capped output) instead of throwing, hanging, or corrupting
 * state.
 */
describe('MCP tool input validation', () => {
  const ws = path.resolve(__dirname, '../fixtures/validation');

  beforeEach(() => {
    fs.mkdirSync(path.join(ws, 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'app.py'),
      ['def alpha():', '    return 1', '', 'def beta():', '    return 2', ''].join('\n')
    );
    fs.writeFileSync(path.join(ws, 'pkg', 'mod.py'), 'VALUE = 42\n');
    // File with no trailing newline and CRLF content
    fs.writeFileSync(path.join(ws, 'crlf.txt'), 'a\r\nb\r\nc');
    // Empty file
    fs.writeFileSync(path.join(ws, 'empty.txt'), '');
  });

  afterEach(() => {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  describe('read_file', () => {
    it('handles missing file gracefully', async () => {
      const res = await executeReadFile(ws, { path: 'does/not/exist.py' });
      expect(res.content[0].text).toContain('not found');
    });

    it('clamps endLine beyond EOF', async () => {
      const res = await executeReadFile(ws, { path: 'app.py', startLine: 1, endLine: 99999 });
      const text = res.content[0].text;
      expect(text).toContain('def alpha():');
      expect(text).toContain('def beta():');
    });

    it('handles startLine beyond EOF', async () => {
      const res = await executeReadFile(ws, { path: 'app.py', startLine: 9999 });
      const text = res.content[0].text;
      expect(text).toBeDefined();
      expect(text).not.toContain('def alpha():');
    });

    it('handles zero/negative line numbers without crashing', async () => {
      const res = await executeReadFile(ws, { path: 'app.py', startLine: -5, endLine: 0 });
      expect(res.content[0].text).toBeDefined();
    });

    it('reads empty file without crashing', async () => {
      const res = await executeReadFile(ws, { path: 'empty.txt' });
      expect(res.content[0].text).toBeDefined();
    });

    it('enforces the 400-line cap on huge files', async () => {
      const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');
      fs.writeFileSync(path.join(ws, 'big.txt'), big);
      const res = await executeReadFile(ws, { path: 'big.txt' });
      const text = res.content[0].text;
      expect(text).toContain('truncated');
      expect(text).not.toContain('line 1000');
    });

    it('handles directory path passed as file', async () => {
      const res = await executeReadFile(ws, { path: 'pkg' });
      // Must not throw; either error text or empty content is acceptable.
      expect(res.content[0].text).toBeDefined();
    });
  });

  describe('find_symbol — regex injection', () => {
    // The tool escapes `name` before interpolating into a RegExp, so hostile
    // names are matched literally and can never crash or act as patterns.
    const hostileNames = ['alpha(', '[', '\\', 'a{2,1}', 'a.*', 'alpha|beta'];
    for (const name of hostileNames) {
      it(`treats "${name}" literally without crashing`, async () => {
        const res = await executeFindSymbol(ws, { name });
        expect(res.content[0].text).toBeDefined();
      });
    }

    it('does not regex-match: "a.*" must not find symbol "alpha"', async () => {
      const res = await executeFindSymbol(ws, { name: 'a.*' });
      expect(res.content[0].text).not.toContain('def alpha');
    });

    it('finds a normal symbol (control)', async () => {
      const res = await executeFindSymbol(ws, { name: 'alpha' });
      expect(res.content[0].text).toContain('alpha');
      expect(res.content[0].text).toContain('app.py');
    });
  });

  describe('search_text', () => {
    it('returns "no matches" for absent query instead of crashing', async () => {
      const res = await executeSearchText(ws, { query: 'zzz-no-such-string-zzz' });
      expect(res.content[0].text).toContain('No matches');
    });

    it('handles empty query', async () => {
      const res = await executeSearchText(ws, { query: '' });
      expect(res.content[0].text).toBeDefined();
    });

    it('respects maxHits cap', async () => {
      fs.writeFileSync(path.join(ws, 'many.txt'), 'hit\n'.repeat(200));
      const res = await executeSearchText(ws, { query: 'hit', maxHits: 5 });
      const text = res.content[0].text;
      const hitLines = text.split('\n').filter((l) => /many\.txt:\d+/.test(l));
      expect(hitLines.length).toBeLessThanOrEqual(5);
    });

    it('skips binary files containing NUL bytes', async () => {
      fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69, 0x74]));
      const res = await executeSearchText(ws, { query: 'hit' });
      // 'hit' appears in app? no — only bin.dat bytes; must not match binary.
      expect(res.content[0].text).not.toContain('bin.dat');
    });
  });

  describe('list_dir', () => {
    it('handles missing directory', async () => {
      const res = await executeListDir(ws, { relativePath: 'no/such/dir' });
      expect(res.content[0].text).toContain('not found');
    });

    it('respects maxDepth', async () => {
      fs.mkdirSync(path.join(ws, 'a', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'a', 'b', 'c', 'deep.txt'), 'x');
      const res = await executeListDir(ws, { relativePath: '.', maxDepth: 1 });
      const text = res.content[0].text;
      expect(text).toContain('a/');
      expect(text).not.toContain('deep.txt');
    });
  });
});
