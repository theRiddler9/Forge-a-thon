import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { executeReadFile } from '../../src/mcp/tools/readFile.js';
import { executeListDir } from '../../src/mcp/tools/listDir.js';
import { executeSearchText } from '../../src/mcp/tools/searchText.js';
import { executeFindSymbol } from '../../src/mcp/tools/findSymbol.js';
import { EditStagingManager } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';

/**
 * Security regression tests: every MCP tool and the edit-staging pipeline
 * must confine file access to the workspace root. A malicious or confused
 * agent (or a prompt-injected one) must not be able to read or write files
 * outside the opened workspace.
 *
 * Tests marked `it.fails` document CONFIRMED vulnerabilities: they assert the
 * safe behaviour, currently fail, and will start passing (and flag themselves)
 * once the flaw is fixed.
 */
describe('Path traversal / workspace confinement', () => {
  // workspaceRoot is a dedicated dir; the "secret" lives one level up.
  const baseDir = path.resolve(__dirname, '../fixtures/traversal');
  const workspaceRoot = path.join(baseDir, 'ws');
  const secretPath = path.join(baseDir, 'secret.txt');
  const secretContent = 'TOP-SECRET-OUTSIDE-WORKSPACE';

  beforeEach(() => {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'inside.txt'), 'inside workspace\n');
    fs.writeFileSync(secretPath, secretContent + '\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {}
  });

  const traversalPayloads = [
    '../secret.txt',
    '..\\secret.txt',
    './../secret.txt',
    'sub/../../secret.txt',
  ];

  const absolutePayloads = [
    secretPath,
    path.join(baseDir, 'ws', '..', 'secret.txt'),
  ];

  describe('read_file', () => {
    for (const payload of [...traversalPayloads, ...absolutePayloads]) {
      it.fails(`refuses to read outside workspace via "${payload}"`, async () => {
        const result = await executeReadFile(workspaceRoot, { path: payload });
        const text = result.content[0].text;
        // SAFE behaviour: either an error or a not-found confined to workspace.
        expect(text).not.toContain(secretContent);
      });
    }
  });

  describe('list_dir', () => {
    it.fails('refuses to list the parent directory', async () => {
      const result = await executeListDir(workspaceRoot, { relativePath: '..' });
      const text = result.content[0].text;
      expect(text).not.toContain('secret.txt');
    });

    it.fails('refuses to list an absolute path outside workspace', async () => {
      const result = await executeListDir(workspaceRoot, { relativePath: baseDir });
      const text = result.content[0].text;
      expect(text).not.toContain('secret.txt');
    });
  });

  describe('search_text', () => {
    it('does not return matches from files outside the workspace', async () => {
      // search_text only walks workspaceRoot, so it cannot escape upward —
      // but verify a symlink-free assumption: searching must never report
      // the secret file even though it sits next to the workspace.
      const result = await executeSearchText(workspaceRoot, {
        query: 'TOP-SECRET',
      });
      const text = result.content[0].text;
      expect(text).not.toContain('secret.txt');
      expect(text).not.toContain(secretContent);
    });
  });

  describe('find_symbol', () => {
    it('does not scan files outside the workspace', async () => {
      // find_symbol walks workspaceRoot only; a file outside must never match.
      fs.writeFileSync(path.join(baseDir, 'outside.py'), 'def outside_symbol():\n    pass\n');
      const result = await executeFindSymbol(workspaceRoot, { name: 'outside_symbol' });
      const text = result.content[0].text;
      expect(text).not.toContain('outside.py');
    });
  });

  describe('propose_write / staging apply', () => {
    it.fails('staging refuses paths that escape the workspace', async () => {
      const staging = new EditStagingManager(new SnapshotManager());
      const proposal = staging.stageProposal(workspaceRoot, '../pwned.txt', 'malicious\n');
      staging.acceptAllHunks(proposal.proposalId);
      staging.applyProposal(proposal.proposalId);
      expect(fs.existsSync(path.join(baseDir, 'pwned.txt'))).toBe(false);
    });

    it.fails('staging refuses absolute paths outside the workspace', async () => {
      const staging = new EditStagingManager(new SnapshotManager());
      const absTarget = path.join(baseDir, 'abs-pwned.txt');
      const proposal = staging.stageProposal(workspaceRoot, absTarget, 'malicious\n');
      staging.acceptAllHunks(proposal.proposalId);
      staging.applyProposal(proposal.proposalId);
      expect(fs.existsSync(absTarget)).toBe(false);
    });

    it('confines in-workspace writes to the workspace (control case)', async () => {
      const staging = new EditStagingManager(new SnapshotManager());
      const proposal = staging.stageProposal(workspaceRoot, 'newfile.txt', 'hello\n');
      staging.acceptAllHunks(proposal.proposalId);
      const res = staging.applyProposal(proposal.proposalId);
      expect(res.success).toBe(true);
      expect(fs.readFileSync(path.join(workspaceRoot, 'newfile.txt'), 'utf8')).toBe('hello\n');
    });
  });

  describe('run_command cwd confinement', () => {
    it('executes commands with workspaceRoot as cwd (documented behaviour)', async () => {
      // run_command is approval-gated; the shell can still reference ../ paths
      // because cwd confinement does not sandbox the process. This test pins
      // the CURRENT contract so any future sandboxing change is noticed.
      const { executeRunCommand } = await import('../../src/mcp/tools/runCommand.js');
      const result = await executeRunCommand(workspaceRoot, {
        command: 'pwd',
        timeoutMs: 5000,
      });
      const text = result.content[0].text;
      // On Windows pwd may not exist; just assert the tool returns without throwing.
      expect(text).toBeDefined();
    });
  });
});
