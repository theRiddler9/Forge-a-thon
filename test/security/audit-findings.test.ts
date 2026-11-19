import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { EditStagingManager } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';
import { computeHunks, applyHunks } from '../../src/edit/hunks.js';
import { executeSearchText } from '../../src/mcp/tools/searchText.js';
import { ContextBudgetTracker } from '../../src/mcp/tools/contextBudget.js';

/**
 * Regression tests for issues found in the security/correctness audit.
 * `it.fails` cases document CONFIRMED flaws; they flip to failures (signal)
 * once the underlying bug is fixed.
 */
describe('Audit finding: stale-content apply', () => {
  const ws = path.resolve(__dirname, '../fixtures/audit_stale');

  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'f.txt'), 'line1\nline2\nline3\n');
  });
  afterEach(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  });

  it.fails('apply refuses when the file changed after staging', () => {
    // KNOWN BUG: hunks are computed against originalContent captured at stage
    // time; applyProposal then replaces the WHOLE document, silently
    // discarding any edit made between staging and approval. Safe behaviour:
    // detect drift (hash mismatch) and refuse or re-diff.
    const staging = new EditStagingManager(new SnapshotManager());
    const prop = staging.stageProposal(ws, 'f.txt', 'line1\nCHANGED\nline3\n');
    staging.acceptAllHunks(prop.proposalId);

    // User (or another tool) edits the file after the proposal was staged
    fs.writeFileSync(path.join(ws, 'f.txt'), 'line1\nline2\nline3\nUSER_EDIT\n');

    staging.applyProposal(prop.proposalId);
    const onDisk = fs.readFileSync(path.join(ws, 'f.txt'), 'utf8');
    expect(onDisk).toContain('USER_EDIT'); // interim edit must survive
  });
});

describe('Audit finding: CRLF corruption on partial hunk apply', () => {
  it.fails('partial apply preserves CRLF outside applied hunks', () => {
    // KNOWN BUG: applyHunks splits on /\r?\n/ (stripping \r) and rejoins with
    // '\n'; untouched regions lose their carriage returns.
    const oldC = 'a\r\nb\r\nc\r\nd\r\ne\r\n';
    const lines = oldC.split('\r\n');
    lines[1] = 'B';
    lines[4] = 'E';
    const newC = lines.join('\r\n') + '\r\n';

    const hunks = computeHunks(oldC, newC);
    expect(hunks.length).toBe(2);
    const { newContent } = applyHunks(oldC, hunks, [hunks[0].id]); // accept only first
    expect(newContent).toContain('\r\n'); // untouched lines keep CRLF
  });
});

describe('Audit finding: search_text glob handling', () => {
  const ws = path.resolve(__dirname, '../fixtures/audit_glob');

  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'notes.py'), 'needle here\n');
    fs.writeFileSync(path.join(ws, 'notes.pyc'), 'needle binary-ish\n');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'a.py'), 'needle in src\n');
  });
  afterEach(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  });

  it.fails('glob "*.py" does not match ".pyc" files', async () => {
    // KNOWN BUG: glob is a basename substring match after stripping '*',
    // so '*.py' -> '.py' also matches 'notes.pyc'.
    const res = await executeSearchText(ws, { query: 'needle', glob: '*.py' });
    const text = res.content[0].text;
    expect(text).not.toContain('notes.pyc');
  });

  it.fails('path-qualified glob "src/*.py" matches files under src/', async () => {
    // KNOWN BUG: 'src/*.py' -> 'src/.py' is tested against the BASENAME only,
    // so it can never match.
    const res = await executeSearchText(ws, { query: 'needle', glob: 'src/*.py' });
    const text = res.content[0].text;
    expect(text).toContain('src/a.py');
  });
});

describe('Audit finding: context budget is advisory only', () => {
  it.fails('recording beyond the budget is rejected or flagged', () => {
    // KNOWN ISSUE: ContextBudgetTracker only accumulates; nothing enforces
    // totalBudget, and usage persists across turns (reset is manual).
    const tracker = new ContextBudgetTracker(100);
    tracker.recordTokens('a.py', 80);
    tracker.recordTokens('b.py', 80); // 160 > 100 budget
    const info = tracker.getBudgetInfo();
    // Safe behaviour would clamp/reject the second record or expose an
    // overBudget flag the tools can act on.
    expect(info.usedTokens).toBeLessThanOrEqual(info.totalBudget);
  });
});
