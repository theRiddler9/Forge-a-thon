import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { computeHunks, applyHunks, HunkInfo } from './hunks.js';
import { SnapshotManager, globalSnapshotManager } from './snapshot.js';

function hashRelPathContent(path: string, content: string): string {
  return crypto
    .createHash('sha256')
    .update(path.replace(/\\/g, '/') + content)
    .digest('hex')
    .slice(0, 16);
}

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

export interface RecentApplyEntry {
  path: string;
  relativePath: string;
  contentHash: string;
  appliedCount: number;
  totalCount: number;
  time: number;
}

export class EditStagingManager {
  private proposals = new Map<string, StagedProposal>();
  private snapshotManager: SnapshotManager;
  private recentApplies: RecentApplyEntry[] = [];

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

    const contentHash = hashRelPathContent(relativePath, proposedContent);

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

  /**
   * Computes the post-apply content without touching disk.
   * Used by the editor-driven apply path (vscode.WorkspaceEdit) so edits land
   * in the editor undo stack. The proposal is NOT removed from the map here;
   * call finalizeProposal() after a successful apply.
   */
  previewProposal(proposalId: string): {
    success: boolean;
    appliedCount: number;
    totalCount: number;
    newContent?: string;
    fullPath?: string;
    relativePath?: string;
    originalContent?: string;
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

    return {
      success: true,
      appliedCount,
      totalCount,
      newContent,
      fullPath: proposal.fullPath,
      relativePath: proposal.relativePath,
      originalContent: proposal.originalContent,
    };
  }

  /**
   * Removes the proposal from the staging map after a successful apply.
   * When appliedCount/totalCount are supplied, the apply is also recorded so
   * the MCP tool can report that the approved edit already landed (instead of
   * staging a duplicate).
   */
  finalizeProposal(proposalId: string, appliedCount?: number, totalCount?: number): void {
    const proposal = this.proposals.get(proposalId);
    if (typeof appliedCount === 'number' && proposal) {
      this.recentApplies.push({
        path: proposal.fullPath,
        relativePath: proposal.relativePath,
        contentHash: proposal.contentHash,
        appliedCount,
        totalCount: totalCount ?? proposal.hunks.length,
        time: Date.now(),
      });
      if (this.recentApplies.length > 20) {
        this.recentApplies.shift();
      }
    }
    this.proposals.delete(proposalId);
  }

  /**
   * Finds a recent apply of (path, newContent) — the approval resume flow runs
   * the same MCP tool again after the extension already applied the edit, and
   * the tool must not stage a duplicate proposal.
   */
  findRecentApply(path: string, newContent: string): RecentApplyEntry | undefined {
    const hash = hashRelPathContent(path, newContent);
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (let i = this.recentApplies.length - 1; i >= 0; i--) {
      const entry = this.recentApplies[i];
      if (entry.time < cutoff) break;
      if (entry.contentHash === hash) {
        return entry;
      }
    }
    return undefined;
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
