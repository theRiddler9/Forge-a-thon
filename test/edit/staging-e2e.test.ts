import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { EditStagingManager } from '../../src/edit/staging.js';
import { SnapshotManager } from '../../src/edit/snapshot.js';
import { globalEditStaging } from '../../src/edit/staging.js';
import { executeProposeWrite } from '../../src/mcp/tools/proposeWrite.js';

/**
 * End-to-end tests for the safe-edit pipeline:
 * stage -> per-hunk decisions -> preview/apply -> snapshot -> undo,
 * plus the approval-resume duplicate guard (findRecentApply).
 */
describe('Edit staging e2e pipeline', () => {
  const ws = path.resolve(__dirname, '../fixtures/staging_e2e');

  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
    globalEditStaging.clearAll();
  });

  afterEach(() => {
    globalEditStaging.clearAll();
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('mixed per-hunk decisions apply only accepted hunks', () => {
    const file = path.join(ws, 'multi.py');
    const original = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    fs.writeFileSync(file, original);

    const lines = original.split('\n');
    lines[1] = 'B-accepted';
    lines[6] = 'G-rejected';
    const proposed = lines.join('\n');

    const staging = new EditStagingManager(new SnapshotManager());
    const prop = staging.stageProposal(ws, 'multi.py', proposed);
    expect(prop.hunks.length).toBe(2);

    // Accept the first hunk, reject the second
    const [h1, h2] = prop.hunks;
    staging.setHunkDecision(prop.proposalId, h1.id, 'accepted');
    staging.setHunkDecision(prop.proposalId, h2.id, 'rejected');

    const res = staging.applyProposal(prop.proposalId);
    expect(res.success).toBe(true);
    expect(res.appliedCount).toBe(1);
    expect(res.totalCount).toBe(2);

    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).toContain('B-accepted');
    expect(onDisk).not.toContain('G-rejected');
    expect(onDisk).toContain('g\n'); // untouched region preserved
  });

  it('previewProposal computes content without touching disk or removing proposal', () => {
    const file = path.join(ws, 'preview.txt');
    fs.writeFileSync(file, 'one\ntwo\n');

    const staging = new EditStagingManager(new SnapshotManager());
    const prop = staging.stageProposal(ws, 'preview.txt', 'one\nTWO\n');
    staging.acceptAllHunks(prop.proposalId);

    const preview = staging.previewProposal(prop.proposalId);
    expect(preview.success).toBe(true);
    expect(preview.newContent).toBe('one\nTWO\n');
    // Disk untouched, proposal still staged
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    expect(staging.getProposal(prop.proposalId)).toBeDefined();
  });

  it('apply -> snapshot -> undo restores original bytes', () => {
    const file = path.join(ws, 'undo_me.txt');
    const original = 'original\ncontent\n';
    fs.writeFileSync(file, original);

    const snaps = new SnapshotManager();
    const staging = new EditStagingManager(snaps);
    const prop = staging.stageProposal(ws, 'undo_me.txt', 'changed\ncontent\n');
    staging.acceptAllHunks(prop.proposalId);
    staging.applyProposal(prop.proposalId);
    expect(fs.readFileSync(file, 'utf8')).toBe('changed\ncontent\n');

    const snap = snaps.undoLastChange();
    expect(snap).not.toBeNull();
    fs.writeFileSync(snap!.filePath, snap!.restoredContent);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('applyProposal on unknown id fails cleanly', () => {
    const staging = new EditStagingManager(new SnapshotManager());
    const res = staging.applyProposal('prop-does-not-exist');
    expect(res.success).toBe(false);
    expect(res.appliedCount).toBe(0);
  });

  it('all-rejected apply leaves file unchanged and reports 0 applied', () => {
    const file = path.join(ws, 'reject_all.txt');
    fs.writeFileSync(file, 'keep me\n');

    const staging = new EditStagingManager(new SnapshotManager());
    const prop = staging.stageProposal(ws, 'reject_all.txt', 'change me\n');
    for (const h of prop.hunks) {
      staging.setHunkDecision(prop.proposalId, h.id, 'rejected');
    }
    const res = staging.applyProposal(prop.proposalId);
    expect(res.appliedCount).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me\n');
  });

  it('re-staging identical content collides on proposalId and resets review state', () => {
    // Documenting current behaviour: proposalId = hash(path+content), so a
    // second identical proposal overwrites the first — including hunk decisions.
    const staging = new EditStagingManager(new SnapshotManager());
    const p1 = staging.stageProposal(ws, 'same.txt', 'v1\n');
    staging.acceptAllHunks(p1.proposalId);
    const p2 = staging.stageProposal(ws, 'same.txt', 'v1\n');
    expect(p2.proposalId).toBe(p1.proposalId);
    const again = staging.getProposal(p1.proposalId)!;
    expect(again.acceptedHunkIds.size).toBe(0); // decisions were reset
  });

  it('independent proposals for different files do not interfere', () => {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b1\n');

    const staging = new EditStagingManager(new SnapshotManager());
    const pa = staging.stageProposal(ws, 'a.txt', 'a2\n');
    const pb = staging.stageProposal(ws, 'b.txt', 'b2\n');
    staging.acceptAllHunks(pa.proposalId);
    staging.applyProposal(pa.proposalId);

    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('a2\n');
    expect(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8')).toBe('b1\n');
    expect(staging.getProposal(pb.proposalId)).toBeDefined();
  });
});

describe('Approval-resume duplicate guard (findRecentApply)', () => {
  const ws = path.resolve(__dirname, '../fixtures/staging_e2e_guard');

  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
    globalEditStaging.clearAll();
  });

  afterEach(() => {
    globalEditStaging.clearAll();
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  it('propose_write reports "already applied" instead of re-staging after approval apply', async () => {
    const rel = 'guarded.txt';
    fs.writeFileSync(path.join(ws, rel), 'before\n');

    // 1. Agent proposes write → staged, nothing on disk
    const first = await executeProposeWrite(ws, { path: rel, newContent: 'after\n' });
    expect(first.content[0].text).toContain('Edit proposed');
    expect(globalEditStaging.getAllProposals()).toHaveLength(1);
    expect(fs.readFileSync(path.join(ws, rel), 'utf8')).toBe('before\n');

    // 2. User accepts → extension previews, applies via editor, finalizes.
    //    (finalizeProposal must run while the proposal is still staged.)
    const prop = globalEditStaging.getAllProposals()[0];
    globalEditStaging.acceptAllHunks(prop.proposalId);
    const preview = globalEditStaging.previewProposal(prop.proposalId);
    expect(preview.appliedCount).toBe(1);
    fs.writeFileSync(path.join(ws, rel), preview.newContent!); // simulate editor apply
    globalEditStaging.finalizeProposal(prop.proposalId, preview.appliedCount, preview.totalCount);
    expect(fs.readFileSync(path.join(ws, rel), 'utf8')).toBe('after\n');

    // 3. TrueForge resumes the turn → MCP tool runs again with same args.
    //    Must NOT stage a duplicate proposal.
    const second = await executeProposeWrite(ws, { path: rel, newContent: 'after\n' });
    expect(second.content[0].text).toContain('already applied');
    expect(globalEditStaging.getAllProposals()).toHaveLength(0);
  });

  it('a genuinely different edit still stages normally after a recent apply', async () => {
    const rel = 'guarded2.txt';
    fs.writeFileSync(path.join(ws, rel), 'v1\n');

    const first = await executeProposeWrite(ws, { path: rel, newContent: 'v2\n' });
    expect(first.content[0].text).toContain('Edit proposed');
    const prop = globalEditStaging.getAllProposals()[0];
    globalEditStaging.acceptAllHunks(prop.proposalId);
    const preview = globalEditStaging.previewProposal(prop.proposalId);
    fs.writeFileSync(path.join(ws, rel), preview.newContent!);
    globalEditStaging.finalizeProposal(prop.proposalId, preview.appliedCount, preview.totalCount);

    const second = await executeProposeWrite(ws, { path: rel, newContent: 'v3\n' });
    expect(second.content[0].text).toContain('Edit proposed');
    expect(globalEditStaging.getAllProposals()).toHaveLength(1);
  });

  it.fails('direct applyProposal path also feeds the duplicate guard', async () => {
    // KNOWN GAP: applyProposal() writes to disk and deletes the proposal but
    // never records a RecentApplyEntry — only the preview/finalize path does.
    // Any caller still using applyProposal leaves the approval-resume guard
    // disarmed, so the resumed MCP call re-stages a duplicate proposal.
    const rel = 'guarded3.txt';
    fs.writeFileSync(path.join(ws, rel), 'before\n');

    await executeProposeWrite(ws, { path: rel, newContent: 'after\n' });
    const prop = globalEditStaging.getAllProposals()[0];
    globalEditStaging.acceptAllHunks(prop.proposalId);
    globalEditStaging.applyProposal(prop.proposalId); // direct disk-write path

    const second = await executeProposeWrite(ws, { path: rel, newContent: 'after\n' });
    expect(second.content[0].text).toContain('already applied');
  });
});
