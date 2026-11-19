import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { EditStagingManager } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';

describe('EditStaging preview/finalize', () => {
  const testDir = path.resolve(__dirname, '../fixtures/preview_test');
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

  it('previews applied content without touching disk or dropping the proposal', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'initial content\nline 2 modified\n');
    staging.setHunkDecision(proposal.proposalId, proposal.hunks[0].id, 'accepted');

    const preview = staging.previewProposal(proposal.proposalId);
    expect(preview.success).toBe(true);
    expect(preview.appliedCount).toBe(1);
    expect(preview.totalCount).toBe(1);
    expect(preview.newContent).toBe('initial content\nline 2 modified\n');

    // Disk untouched and proposal still staged
    expect(fs.readFileSync(filePath, 'utf8')).toBe('initial content\nline 2\n');
    expect(staging.getProposal(proposal.proposalId)).toBeDefined();
  });

  it('finds a recent apply by path + content hash after finalize', () => {
    const staging = new EditStagingManager();
    const content = 'initial content\nline 2 modified\n';
    const proposal = staging.stageProposal(testDir, 'target.py', content);
    staging.setHunkDecision(proposal.proposalId, proposal.hunks[0].id, 'accepted');

    staging.finalizeProposal(proposal.proposalId, 1, 1);

    const found = staging.findRecentApply('target.py', content);
    expect(found).toBeDefined();
    expect(found?.appliedCount).toBe(1);
    expect(found?.relativePath).toBe('target.py');

    // Different content must not match
    expect(staging.findRecentApply('target.py', 'something else\n')).toBeUndefined();
    // Different path must not match
    expect(staging.findRecentApply('other.py', content)).toBeUndefined();
  });

  it('does not record an apply when finalized without counts (discard path)', () => {
    const staging = new EditStagingManager();
    const proposal = staging.stageProposal(testDir, 'target.py', 'changed\n');
    staging.discardProposal(proposal.proposalId);
    expect(staging.findRecentApply('target.py', 'changed\n')).toBeUndefined();
  });
});
