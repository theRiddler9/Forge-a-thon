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

export interface FinalizedProposalRecord {
  proposalId: string;
  relativePath: string;
  fullPath: string;
  appliedCount: number;
  totalCount: number;
  time: number;
}

/**
 * Applies a list of targeted { search, replace } edits to existing file content.
 */
export function applyEditsToContent(
  originalContent: string,
  edits: Array<{ search: string; replace: string }>
): string {
  let content = originalContent;
  for (const edit of edits) {
    if (!edit || !edit.search) continue;
    if (content.includes(edit.search)) {
      content = content.replace(edit.search, edit.replace ?? '');
    } else {
      // Normalise CRLF vs LF and retry
      const normContent = content.replace(/\r\n/g, '\n');
      const normSearch = edit.search.replace(/\r\n/g, '\n');
      const normReplace = (edit.replace ?? '').replace(/\r\n/g, '\n');
      if (normContent.includes(normSearch)) {
        content = normContent.replace(normSearch, normReplace);
      }
    }
  }
  return content;
}

/**
 * Detects whether proposedContent is a truncated prefix, suffix, or snippet
 * of originalContent (common when fast LLMs output only the lines around an edit)
 * and reconciles it against the full original content to avoid accidental truncation.
 */
export function reconcileProposedContent(
  originalContent: string,
  proposedContent: string
): string {
  if (!originalContent || !proposedContent) return proposedContent;

  const origLines = originalContent.split(/\r?\n/);
  const propLines = proposedContent.split(/\r?\n/);

  // If proposed content is already most of the file or original is small, no truncation occurred
  if (origLines.length < 35 || propLines.length >= origLines.length * 0.75) {
    return proposedContent;
  }

  const propNonEmpty = propLines
    .map((l, i) => ({ line: l.trim(), idx: i }))
    .filter((x) => x.line.length > 0);
  if (propNonEmpty.length < 3) return proposedContent;

  // Case A: Proposed content is a prefix snippet (starts at top, ends mid-file)
  const last3 = propNonEmpty.slice(-3);
  const lastAnchor = last3[last3.length - 1].line;

  let bestOrigMatchIdx = -1;
  let minDistance = Infinity;

  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].trim() === lastAnchor) {
      let allMatch = true;
      for (let j = 0; j < last3.length - 1; j++) {
        const offset = last3.length - 1 - j;
        const targetLine = i - offset;
        if (targetLine < 0 || origLines[targetLine].trim() !== last3[j].line) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        const dist = Math.abs(i - propLines.length);
        if (dist < minDistance) {
          minDistance = dist;
          bestOrigMatchIdx = i;
        }
      }
    }
  }

  if (bestOrigMatchIdx !== -1 && bestOrigMatchIdx < origLines.length - 1) {
    const firstAnchor = propNonEmpty[0].line;
    const firstMatch = origLines.slice(0, 10).some((l) => l.trim() === firstAnchor);
    if (firstMatch) {
      const remainder = origLines.slice(bestOrigMatchIdx + 1);
      const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
      return proposedContent.replace(/\r?\n$/, '') + eol + remainder.join(eol);
    }
  }

  // Case B: Proposed content is a suffix snippet (starts mid-file, ends at bottom)
  const first3 = propNonEmpty.slice(0, 3);
  const firstAnchor = first3[0].line;
  let bestSuffixStartIdx = -1;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].trim() === firstAnchor) {
      let allMatch = true;
      for (let j = 1; j < first3.length; j++) {
        if (i + j >= origLines.length || origLines[i + j].trim() !== first3[j].line) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        bestSuffixStartIdx = i;
        break;
      }
    }
  }

  if (bestSuffixStartIdx > 10) {
    const lastAnchor = propNonEmpty[propNonEmpty.length - 1].line;
    const lastOrigAnchor = origLines.slice(-10).some((l) => l.trim() === lastAnchor);
    if (lastOrigAnchor) {
      const prefix = origLines.slice(0, bestSuffixStartIdx);
      const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
      return prefix.join(eol) + eol + proposedContent.replace(/^\r?\n/, '');
    }
  }

  // Case C: Proposed content is a middle snippet (e.g. inline edit replacing a function)
  const midFirstAnchor = propNonEmpty[0].line;
  let midStartIdx = -1;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i].trim() === midFirstAnchor) {
      midStartIdx = i;
      break;
    }
  }

  if (midStartIdx >= 0) {
    const midLastAnchor = propNonEmpty[propNonEmpty.length - 1].line;
    let midEndIdx = -1;

    for (let i = midStartIdx; i < origLines.length; i++) {
      if (origLines[i].trim() === midLastAnchor) {
        midEndIdx = i;
        break;
      }
    }

    if (midEndIdx === -1) {
      for (let i = midStartIdx + 1; i < origLines.length; i++) {
        const line = origLines[i];
        if (/^(def\s+|class\s+|@)/.test(line.trim()) && !line.startsWith(' ') && !line.startsWith('\t')) {
          midEndIdx = i - 1;
          break;
        }
      }
    }

    if (midEndIdx !== -1 && (midStartIdx > 0 || midEndIdx < origLines.length - 1)) {
      const prefix = origLines.slice(0, midStartIdx);
      const suffix = origLines.slice(midEndIdx + 1);
      const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
      const parts: string[] = [];
      if (prefix.length > 0) parts.push(prefix.join(eol));
      parts.push(proposedContent.trim());
      if (suffix.length > 0) parts.push(suffix.join(eol));
      return parts.join(eol + eol);
    }
  }

  return proposedContent;
}

export class EditStagingManager {
  private proposals = new Map<string, StagedProposal>();
  private snapshotManager: SnapshotManager;
  private recentApplies: RecentApplyEntry[] = [];
  private finalizedProposals = new Map<string, FinalizedProposalRecord>();

  constructor(snapshotManager: SnapshotManager = globalSnapshotManager) {
    this.snapshotManager = snapshotManager;
  }

  stageProposal(
    workspaceRoot: string,
    relativePath: string,
    rawProposedContent: string,
    toolCallId?: string,
    edits?: Array<{ search: string; replace: string }>
  ): StagedProposal {
    const normRel = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const fullPath = path.resolve(workspaceRoot, normRel);
    let originalContent = '';
    if (fs.existsSync(fullPath)) {
      originalContent = fs.readFileSync(fullPath, 'utf8');
    }

    let proposedContent = rawProposedContent;
    if (Array.isArray(edits) && edits.length > 0 && originalContent) {
      proposedContent = applyEditsToContent(originalContent, edits);
    } else if (originalContent && proposedContent) {
      proposedContent = reconcileProposedContent(originalContent, proposedContent);
    }

    const contentHash = hashRelPathContent(normRel, proposedContent);

    const proposalId = `prop-${contentHash}`;
    const hunks = computeHunks(originalContent, proposedContent);

    const proposal: StagedProposal = {
      proposalId,
      workspaceRoot,
      relativePath: normRel,
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
    const direct = this.proposals.get(proposalId);
    if (direct) return direct;

    // Fallback: search by prefix/hash or relative path
    for (const p of this.proposals.values()) {
      if (
        p.proposalId === proposalId ||
        p.relativePath === proposalId ||
        p.fullPath === proposalId ||
        proposalId.includes(p.proposalId) ||
        p.proposalId.includes(proposalId)
      ) {
        return p;
      }
    }
    return undefined;
  }

  getAllRecentApplies(): RecentApplyEntry[] {
    return [...this.recentApplies];
  }

  getAllProposals(): StagedProposal[] {
    return Array.from(this.proposals.values());
  }

  setHunkDecision(
    proposalId: string,
    hunkId: string,
    decision: 'accepted' | 'rejected'
  ): boolean {
    const proposal = this.getProposal(proposalId);
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
    const proposal = this.getProposal(proposalId);
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
    const proposal = this.getProposal(proposalId);
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
    const proposal = this.getProposal(proposalId);
    const realId = proposal?.proposalId ?? proposalId;
    const rel = proposal?.relativePath ?? '';
    const full = proposal?.fullPath ?? '';
    const count = typeof appliedCount === 'number' ? appliedCount : (proposal?.acceptedHunkIds.size ?? 1);
    const total = totalCount ?? (proposal?.hunks.length ?? 1);

    const record: FinalizedProposalRecord = {
      proposalId: realId,
      relativePath: rel,
      fullPath: full,
      appliedCount: count,
      totalCount: total,
      time: Date.now(),
    };

    this.finalizedProposals.set(realId, record);
    this.finalizedProposals.set(proposalId, record);
    if (rel) this.finalizedProposals.set(rel, record);

    if (proposal && typeof appliedCount === 'number') {
      this.recentApplies.push({
        path: proposal.fullPath,
        relativePath: proposal.relativePath,
        contentHash: proposal.contentHash,
        appliedCount,
        totalCount: total,
        time: Date.now(),
      });
      if (this.recentApplies.length > 20) {
        this.recentApplies.shift();
      }
    }

    this.proposals.delete(realId);
    this.proposals.delete(proposalId);
  }

  isFinalized(proposalId: string): boolean {
    if (this.finalizedProposals.has(proposalId)) return true;
    const clean = proposalId.replace(/^prop-/, '');
    for (const rec of this.finalizedProposals.values()) {
      if (
        rec.proposalId === proposalId ||
        rec.relativePath === proposalId ||
        rec.fullPath === proposalId ||
        proposalId.includes(rec.proposalId) ||
        rec.proposalId.includes(proposalId) ||
        (clean.length >= 8 && rec.proposalId.includes(clean))
      ) {
        return true;
      }
    }
    return false;
  }

  getFinalizedRecord(proposalId: string): FinalizedProposalRecord | undefined {
    const direct = this.finalizedProposals.get(proposalId);
    if (direct) return direct;
    const clean = proposalId.replace(/^prop-/, '');
    for (const rec of this.finalizedProposals.values()) {
      if (
        rec.proposalId === proposalId ||
        rec.relativePath === proposalId ||
        rec.fullPath === proposalId ||
        proposalId.includes(rec.proposalId) ||
        rec.proposalId.includes(proposalId) ||
        (clean.length >= 8 && rec.proposalId.includes(clean))
      ) {
        return rec;
      }
    }
    return undefined;
  }

  /**
   * Finds a recent apply of (path, newContent) — the approval resume flow runs
   * the same MCP tool again after the extension already applied the edit, and
   * the tool must not stage a duplicate proposal.
   */
  findRecentApply(pathOrRel: string, newContent: string): RecentApplyEntry | undefined {
    const norm = pathOrRel.replace(/\\/g, '/');
    const hash = hashRelPathContent(norm, newContent);
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (let i = this.recentApplies.length - 1; i >= 0; i--) {
      const entry = this.recentApplies[i];
      if (entry.time < cutoff) break;
      const pathMatches =
        entry.relativePath === norm ||
        entry.path.replace(/\\/g, '/').endsWith(norm) ||
        norm.endsWith(entry.relativePath);
      if (!pathMatches) continue;

      if (entry.contentHash === hash) {
        return entry;
      }

      // If the proposed content (or snippet) is already present in the file on disk
      // following user approval, treat it as already applied
      try {
        if (fs.existsSync(entry.path)) {
          const currentOnDisk = fs.readFileSync(entry.path, 'utf8');
          const trimmed = newContent.trim();
          if (trimmed.length > 0 && currentOnDisk.includes(trimmed)) {
            return entry;
          }
        }
      } catch {}
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
    const proposal = this.getProposal(proposalId);
    if (proposal) {
      this.proposals.delete(proposal.proposalId);
    }
    this.proposals.delete(proposalId);
  }

  clearAll(): void {
    this.proposals.clear();
    // Keep finalizedProposals and recentApplies so history and idempotency are preserved
  }
}

export const globalEditStaging = new EditStagingManager();
