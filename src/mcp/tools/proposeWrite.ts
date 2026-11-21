import fs from 'fs';
import { globalEditStaging, applyEditsToContent, reconcileProposedContent } from '../../edit/staging.js';
import { resolveInWorkspace, WorkspaceEscapeError } from './pathGuard.js';

export interface ProposeWriteArgs {
  path: string;
  newContent?: string;
  edits?: Array<{ search: string; replace: string; reason?: string }>;
  rationale?: string;
  proposalId?: string;
}

export async function executeProposeWrite(
  workspaceRoot: string,
  args: ProposeWriteArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let fullPath: string;
  try {
    fullPath = resolveInWorkspace(workspaceRoot, args.path);
  } catch (err) {
    if (err instanceof WorkspaceEscapeError) {
      return { content: [{ type: 'text', text: err.message }] };
    }
    throw err;
  }
  let origContent = '';
  if (fs.existsSync(fullPath)) {
    origContent = fs.readFileSync(fullPath, 'utf8');
  }

  let finalContent = args.newContent ?? '';
  if (Array.isArray(args.edits) && args.edits.length > 0 && origContent) {
    finalContent = applyEditsToContent(origContent, args.edits);
  } else if (origContent && finalContent) {
    finalContent = reconcileProposedContent(origContent, finalContent);
  }

  // If this exact edit was already applied by the approval flow (the user
  // clicked Apply and the extension wrote it), report that instead of
  // staging a duplicate proposal.
  const recent = globalEditStaging.findRecentApply(args.path, finalContent);
  if (recent) {
    return {
      content: [
        {
          type: 'text',
          text: `Edit already applied: ${recent.appliedCount}/${recent.totalCount} hunks applied to ${recent.relativePath} after user approval. The change is on disk and tracked by the snapshot history (ForgePilot: Undo Last Applied Change).`,
        },
      ],
    };
  }

  // Stage the proposal for user review — nothing is written here.
  const proposal = globalEditStaging.stageProposal(
    workspaceRoot,
    args.path,
    args.newContent ?? '',
    undefined,
    args.edits,
    args.rationale
  );

  const rationaleLine = args.rationale ? ` Rationale: ${args.rationale}` : '';
  return {
    content: [
      {
        type: 'text',
        text: `Edit proposed for ${proposal.relativePath} (${proposal.hunks.length} hunks).${rationaleLine} The user will review each hunk and approve or reject. Nothing touches disk until then.`,
      },
    ],
  };
}
