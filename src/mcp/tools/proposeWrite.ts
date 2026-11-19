import { globalEditStaging } from '../../edit/staging.js';

export interface ProposeWriteArgs {
  path: string;
  newContent: string;
  proposalId?: string;
}

export async function executeProposeWrite(
  workspaceRoot: string,
  args: ProposeWriteArgs
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // If this exact edit was already applied by the approval flow (the user
  // clicked Apply and the extension wrote it), report that instead of
  // staging a duplicate proposal.
  const recent = globalEditStaging.findRecentApply(args.path, args.newContent);
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
    args.newContent
  );

  return {
    content: [
      {
        type: 'text',
        text: `Edit proposed for ${proposal.relativePath} (${proposal.hunks.length} hunks). The user will review each hunk and approve or reject. Nothing touches disk until then.`,
      },
    ],
  };
}
