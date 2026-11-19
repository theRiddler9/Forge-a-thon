import * as vscode from 'vscode';
import path from 'path';
import { TrueForgeClient } from '../trueforge/client.js';
import { globalEditStaging } from '../edit/staging.js';
import { globalHunkCodeLensProvider } from '../edit/codelens.js';

export function registerInlineEditCommand(
  context: vscode.ExtensionContext,
  client: TrueForgeClient,
  workspaceRoot: string
) {
  const disposable = vscode.commands.registerCommand('forgepilot.inlineEdit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('ForgePilot: Open an editor to use inline edit.');
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    const instruction = await vscode.window.showInputBox({
      title: `ForgePilot Inline Edit (${filePath}:${startLine}-${endLine})`,
      prompt: 'Enter instructions for the selected code',
      placeHolder: 'e.g. Treat the values off and n as false as well, case-insensitively...',
    });

    if (!instruction) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ForgePilot: Generating inline edit...',
        cancellable: true,
      },
      async (_progress, token) => {
        try {
          const inlinePrompt = [
            `File: ${filePath}`,
            `Lines: ${startLine}-${endLine}`,
            `Selected Code:\n${selectedText}`,
            `Instruction: ${instruction}`,
            `CRITICAL INSTRUCTION: Edit only the selected code or function. Call propose_write once with the complete modified file content.`,
          ].join('\n\n');

          const session = await client.createSessionWithFallback(
            'You are an inline code editing agent. Respond strictly by calling propose_write once with the modified content.'
          );

          token.onCancellationRequested(async () => {
            await client.cancelSession(session.id);
            globalEditStaging.clearAll();
            globalHunkCodeLensProvider.refresh();
          });

          await client.streamTurn(session.id, inlinePrompt, {
            onToolApprovalRequired: async (toolCallId, toolName, args) => {
              if (toolName === 'propose_write') {
                const proposal = globalEditStaging.stageProposal(
                  workspaceRoot,
                  args.path,
                  args.newContent
                );

                globalHunkCodeLensProvider.refresh();

                // Show action buttons to user
                const choice = await vscode.window.showInformationMessage(
                  `ForgePilot proposed ${proposal.hunks.length} hunk(s) for ${filePath}.`,
                  'Accept All',
                  'Reject All'
                );

                if (choice === 'Accept All') {
                  globalEditStaging.acceptAllHunks(proposal.proposalId);
                  globalEditStaging.applyProposal(proposal.proposalId);
                  await client.resumeApproval(session.id, toolCallId, 'allow');
                  vscode.window.showInformationMessage(`Applied all hunks to ${filePath}.`);
                } else {
                  globalEditStaging.discardProposal(proposal.proposalId);
                  await client.resumeApproval(session.id, toolCallId, 'deny', 'User rejected proposal');
                }

                globalHunkCodeLensProvider.refresh();
              }
            },
          });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Inline edit failed: ${err.message}`);
        }
      }
    );
  });

  context.subscriptions.push(disposable);
}
