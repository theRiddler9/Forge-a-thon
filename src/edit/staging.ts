import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { computeHunks, applyHunks, HunkInfo } from './hunks.js';
import { SnapshotManager, globalSnapshotManager } from './snapshot.js';

export interface StagedProposal {
  proposalId: string;
  workspaceRoot: string;
  relativePath: string;
  fullPath: string;
  originalContent: string;
  proposedContent: string;
  contentHash: string;
  hunks: HunkInfo[];
  acceptedHunkIds: Set<string>;
  rejectedHunkIds: Set<string>;
  createdAt: number;
  toolCallId?: string;
}

export class EditStagingManager {
  private proposals = new Map<string, StagedProposal>();
  private snapshotManager: SnapshotManager;

  constructor(snapshotManager: SnapshotManager = globalSnapshotManager) {
    this.snapshotManager = snapshotManager;
  }

  stageProposal(
    workspaceRoot: string,
    relativePath: string,
    proposedContent: string,
    toolCallId?: string
  ): StagedProposal {
    const fullPath = path.resolve(workspaceRoot, relativePath);
    let originalContent = '';
    if (fs.existsSync(fullPath)) {
      originalContent = fs.readFileSync(fullPath, 'utf8');
    }

    const contentHash = crypto
      .createHash('sha256')
      .update(relativePath + proposedContent)
      .digest('hex')
      .slice(0, 16);

    const proposalId = `prop-${contentHash}`;
    const hunks = computeHunks(originalContent, proposedContent);

    const proposal: StagedProposal = {
      proposalId,
      workspaceRoot,
      relativePath: relativePath.replace(/\\/g, '/'),
      fullPath,
      originalContent,
      proposedContent,
      contentHash,
      hunks,
      acceptedHunkIds: new Set<string>(),
      rejectedHunkIds: new Set<string>(),
      createdAt: Date.now(),
      toolCallId,
    };

    this.proposals.set(proposalId, proposal);
    return proposal;
  }

  getProposal(proposalId: string): StagedProposal | undefined {
    return this.proposals.get(proposalId);
  }

  getAllProposals(): StagedProposal[] {
    return Array.from(this.proposals.values());
  }

  setHunkDecision(
    proposalId: string,
    hunkId: string,
    decision: 'accepted' | 'rejected'
  ): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    const hunk = proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk) return false;

    if (decision === 'accepted') {
      proposal.acceptedHunkIds.add(hunkId);
      proposal.rejectedHunkIds.delete(hunkId);
      hunk.state = 'accepted';
    } else {
      proposal.rejectedHunkIds.add(hunkId);
      proposal.acceptedHunkIds.delete(hunkId);
      hunk.state = 'rejected';
    }
    return true;
  }

  acceptAllHunks(proposalId: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    for (const hunk of proposal.hunks) {
      proposal.acceptedHunkIds.add(hunk.id);
      proposal.rejectedHunkIds.delete(hunk.id);
      hunk.state = 'accepted';
    }
    return true;
  }

  applyProposal(proposalId: string): {
    success: boolean;
    appliedCount: number;
    totalCount: number;
    filePath?: string;
  } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { success: false, appliedCount: 0, totalCount: 0 };
    }

    const { newContent, appliedCount, totalCount } = applyHunks(
      proposal.originalContent,
      proposal.hunks,
      Array.from(proposal.acceptedHunkIds)
    );

    if (appliedCount > 0) {
      // Create snapshot before modifying disk
      this.snapshotManager.createSnapshot(proposal.fullPath, proposal.originalContent);

      // Ensure directory exists
      fs.mkdirSync(path.dirname(proposal.fullPath), { recursive: true });
      fs.writeFileSync(proposal.fullPath, newContent, 'utf8');
    }

    this.proposals.delete(proposalId);
    return {
      success: true,
      appliedCount,
      totalCount,
      filePath: proposal.relativePath,
    };
  }

  discardProposal(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  clearAll(): void {
    this.proposals.clear();
  }
}

export const globalEditStaging = new EditStagingManager();
