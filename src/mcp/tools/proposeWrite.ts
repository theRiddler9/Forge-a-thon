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
  // If a proposalId is passed and already approved
  if (args.proposalId) {
    const applyResult = globalEditStaging.applyProposal(args.proposalId);
    if (applyResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Successfully applied ${applyResult.appliedCount}/${applyResult.totalCount} hunks to ${applyResult.filePath}.`,
          },
        ],
      };
    }
  }

  // Otherwise, stage the proposal
  const proposal = globalEditStaging.stageProposal(
    workspaceRoot,
    args.path,
    args.newContent
  );

  return {
    content: [
      {
        type: 'text',
        text: `Edit proposed for ${proposal.relativePath} (${proposal.hunks.length} hunks). Proposal ID: ${proposal.proposalId}. Awaiting user review and approval.`,
      },
    ],
  };
}
