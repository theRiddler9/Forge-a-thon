import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { EditStagingManager } from '../../src/edit/staging.js';
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
});
