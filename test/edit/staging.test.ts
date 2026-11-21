import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { EditStagingManager, applyEditsToContent, reconcileProposedContent } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';

describe('EditStaging & SnapshotManager', () => {
  const testDir = path.resolve(__dirname, '../fixtures/staging_test');
  const filePath = path.join(testDir, 'target.py');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(filePath, 'initial content\nline 2\n');
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('stages proposal without touching disk', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'initial content\nline 2 modified\n');

    expect(proposal.proposalId).toBeDefined();
    expect(proposal.hunks.length).toBe(1);

    // Verify disk content is completely untouched
    const diskContent = fs.readFileSync(filePath, 'utf8');
    expect(diskContent).toBe('initial content\nline 2\n');
  });

  it('applies accepted hunks to disk and records snapshot', () => {
    const snapshotManager = new SnapshotManager();
    const staging = new EditStagingManager(snapshotManager);

    const proposal = staging.stageProposal(testDir, 'target.py', 'initial content\nline 2 modified\n');
    staging.setHunkDecision(proposal.proposalId, proposal.hunks[0].id, 'accepted');

    const result = staging.applyProposal(proposal.proposalId);
    expect(result.success).toBe(true);
    expect(result.appliedCount).toBe(1);

    // Verify disk content is updated
    const updatedDiskContent = fs.readFileSync(filePath, 'utf8');
    expect(updatedDiskContent).toBe('initial content\nline 2 modified\n');

    // Verify snapshot manager can undo the change
    expect(snapshotManager.canUndo()).toBe(true);
    const undoResult = snapshotManager.undoLastChange();
    expect(undoResult).toBeDefined();
    expect(undoResult?.filePath).toBe(filePath);

    // Restore to disk
    fs.writeFileSync(undoResult!.filePath, undoResult!.restoredContent);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('initial content\nline 2\n');
  });

  it('discards proposal completely leaving disk untouched', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'changed content\n');

    staging.discardProposal(proposal.proposalId);
    expect(staging.getProposal(proposal.proposalId)).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('initial content\nline 2\n');
  });

  it('applies search-and-replace edits accurately', () => {
    const original = 'def foo():\n    return 42\n\ndef bar():\n    return "hello"\n';
    const edits = [
      { search: 'return 42', replace: 'return 100' },
      { search: 'return "hello"', replace: 'return "world"' },
    ];
    const result = applyEditsToContent(original, edits);
    expect(result).toBe('def foo():\n    return 100\n\ndef bar():\n    return "world"\n');
  });

  it('reconciles prefix snippet on large file to prevent truncation', () => {
    // 50 lines original file
    const origLines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      origLines.push(`line_${i} = ${i}`);
    }
    const original = origLines.join('\n');

    // Model only outputs lines 1 to 10 with a modification at line 3
    const propLines = origLines.slice(0, 10);
    propLines[2] = 'line_3 = 999';
    const proposed = propLines.join('\n');

    const reconciled = reconcileProposedContent(original, proposed);
    const recLines = reconciled.split('\n');

    expect(recLines.length).toBe(60);
    expect(recLines[2]).toBe('line_3 = 999');
    expect(recLines[59]).toBe('line_60 = 60');
  });

  it('tracks finalized proposals to ensure idempotent apply', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'new content\n');
    expect(staging.isFinalized(proposal.proposalId)).toBe(false);

    staging.finalizeProposal(proposal.proposalId, 1, 1);
    expect(staging.isFinalized(proposal.proposalId)).toBe(true);
    expect(staging.getProposal(proposal.proposalId)).toBeUndefined();
    expect(staging.getFinalizedRecord(proposal.proposalId)?.appliedCount).toBe(1);
  });

  it('pending decision clears accepted/rejected state (webview deselect sync)', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'changed content\n');
    const hunkId = proposal.hunks[0].id;

    staging.setHunkDecision(proposal.proposalId, hunkId, 'accepted');
    expect(proposal.acceptedHunkIds.has(hunkId)).toBe(true);
    expect(proposal.decisionMade).toBe(true);

    // User deselects the hunk in the review card — must clear server state too
    staging.setHunkDecision(proposal.proposalId, hunkId, 'pending');
    expect(proposal.acceptedHunkIds.has(hunkId)).toBe(false);
    expect(proposal.rejectedHunkIds.has(hunkId)).toBe(false);
    expect(proposal.hunks[0].state).toBe('pending');
    // decisionMade stays true so apply does not fall back to accept-all
    expect(proposal.decisionMade).toBe(true);
  });
});
